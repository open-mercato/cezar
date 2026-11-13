import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, Routes, Route } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { telegramDescriptor } from '@/lib/chat-providers/telegram'
import { IntegrationsSection, LegacyWebhooksRedirect } from './integrations-section'

const ws = vi.hoisted(() => ({ unsubscribed: [] as string[], subscribed: [] as string[] }))
vi.mock('@/api/ws', async importOriginal => ({ ...await importOriginal<typeof import('@/api/ws')>(),
  subscribeTopic: (topic: string) => { ws.subscribed.push(topic); return () => { ws.unsubscribed.push(topic) } } }))

const jira = { kind: 'jira', connectionId: 'connection-1', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'Platform' }
const connection = { id: 'connection-1', kind: 'jira', origin: 'https://acme.atlassian.net', email: 'user@example.com' }
const installed = { configFile: 'e2e.config.ts', workflow: true, credentials: [], setup: null }
const PENDING = Symbol('pending')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function mount(overrides: Record<string, unknown> = {}, offline = false, enabled = false, initialEntry = '/') {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (offline) return json({ error: 'Offline' }, 503)
    const url = String(input)
    const suffix = Object.keys(overrides).find(key => url.endsWith(key))
    if (suffix) return overrides[suffix] === PENDING ? new Promise<Response>(() => {}) : json(overrides[suffix])
    if (url.endsWith('/extensions/inventory') && overrides['/extensions/access']) {
      const records = (overrides['/extensions/access'] as { extensions: ReturnType<typeof recoveryExtension>[] }).extensions
      return json({ extensions: records.map(record => ({ record, provenance: { kind: 'folder', source: record.source }, availability: record.status === 'running' ? 'available' : record.status === 'failed' ? 'failed' : 'disabled', selectedVersion: record.manifest.version, providers: [{ id: 'example/chat', label: 'Mattermost' }] })) })
    }
    if (url.endsWith('/tracker/association')) return json({ association: jira })
    if (url.endsWith('/tracker/connection')) return json({ connection, demo: false })
    if (url.endsWith('/e2e')) return json(installed)
    if (/\/(telegram|slack|discord)$/.test(url)) return json({ available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] })
    return json({ error: 'Unexpected request' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  for (const project of ['alpha', 'beta']) client.setQueryData([project, 'health'], { capabilities: { webhooks: enabled, extensions: true, localHandoff: true } })
  const tree = (projectId: string) => <QueryClientProvider client={client}><MemoryRouter initialEntries={[initialEntry]}><ProjectScopeProvider projectId={projectId}><IntegrationsSection /></ProjectScopeProvider></MemoryRouter></QueryClientProvider>
  const view = render(tree('alpha'))
  return { fetch, client, switchProject: () => view.rerender(tree('beta')) }
}

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

describe('Integrations gallery', () => {
  it.each([
    ['slack', 'Slack webhook guide', 'https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/'],
    ['discord', 'Discord webhook guide', 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks'],
  ])('links the %s notification guide directly to the provider documentation', async (integration, label, href) => {
    mount({ '/webhooks': { receivers: [receiver(`${integration}-hook`, `${integration}.v1`)], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true, `/?integration=${integration}`)
    const link = await screen.findByRole('link', { name: label })
    expect(link.getAttribute('href')).toBe(href)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
  })

  it.each(['webhooks', 'slack', 'discord'])('shows only %s deleted receivers in that tile', async integration => {
    const history = ['cezar.json.v1', 'slack.v1', 'discord.v1'].map((format, i) => ({ kind: 'history', id: `deleted-${i}`, name: `Deleted ${format}`, format, deletedAt: '2026-11-04T12:00:00Z' }))
    mount({ '/webhooks': { receivers: [], history, historyCount: 3, changeSequence: 0, webhookHealth: { status: 'ready' } }, '/webhooks/history?limit=100': { items: history, total: 3, hasMore: false } }, false, true, `/?integration=${integration}`)
    fireEvent.click(await screen.findByRole('button', { name: 'Show deleted receivers' }))
    const own = integration === 'webhooks' ? 'cezar.json.v1' : `${integration}.v1`
    expect(await screen.findByRole('button', { name: new RegExp(`Deleted ${own}`) })).toBeTruthy()
    for (const row of history.filter(row => row.format !== own)) expect(screen.queryByRole('button', { name: new RegExp(row.name) })).toBeNull()
  })

  it.each([['webhooks', 'Your own HTTPS endpoint (signed JSON)'], ['slack', 'Slack channel (Incoming Webhook)'], ['discord', 'Discord channel (Webhook URL)']])('locks the %s add form to its own destination', async (integration, label) => {
    mount({ '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true, `/?integration=${integration}`)
    const add = await screen.findByRole('button', { name: integration === 'webhooks' ? 'Add receiver' : `Connect ${integration === 'slack' ? 'Slack' : 'Discord'}` })
    await waitFor(() => expect(add).toHaveProperty('disabled', false))
    // Without webhook-only receivers the chat tiles show no separate receiver list.
    if (integration !== 'webhooks') expect(screen.queryByRole('heading', { name: 'Notifications only' })).toBeNull()
    fireEvent.click(add)
    if (integration !== 'webhooks') fireEvent.click(screen.getByRole('button', { name: /^Notifications only/ }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('combobox', { name: 'Destination' })).toBeNull()
    expect(within(dialog).getByText(label)).toBeTruthy()
    if (integration === 'webhooks') {
      fireEvent.change(within(dialog).getByLabelText('Receiver URL'), { target: { value: 'https://hooks.slack.com/services/TA/BB/secret' } })
      expect(within(dialog).queryByRole('button', { name: 'Use Slack' })).toBeNull()
      expect(within(dialog).getByText(/Integrations → Slack/)).toBeTruthy()
    }
  })

  it.each(['telegram', 'slack', 'discord'])('shows a %s change notice only in its integration, including after deletion', async provider => {
    const notice = { changeSequence: 7, at: '2026-11-04T12:00:00Z', action: 'activated', receiverId: 'removed-receiver', receiverName: 'Changed chat', format: `${provider}.v1`, source: 'cockpit/api' }
    mount({ '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 7, webhookHealth: { status: 'ready' }, notice } }, false, true)
    for (const name of ['Webhooks', 'Telegram', 'Slack', 'Discord']) {
      fireEvent.click(await screen.findByRole('button', { name: `Configure ${name}` }))
      await screen.findByRole('region', { name })
      if (name.toLowerCase() === provider) expect(await screen.findByRole('button', { name: 'Mark as reviewed' })).toBeTruthy()
      else expect(screen.queryByRole('button', { name: 'Mark as reviewed' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'All integrations' }))
    }
  })
  it('acknowledges the Telegram notice with its current change sequence', async () => {
    const notice = { changeSequence: 7, at: '2026-11-04T12:00:00Z', action: 'activated', receiverName: 'Changed chat', format: 'telegram.v1' }
    const { fetch } = mount({ '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 7, webhookHealth: { status: 'ready' }, notice }, '/webhooks/notice/acknowledge': {} }, false, true, '/?integration=telegram')
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as reviewed' }))
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/webhooks/notice/acknowledge'))).toBe(true))
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith('/webhooks/notice/acknowledge'))!
    expect(JSON.parse(String(call[1]?.body))).toEqual({ expectedChangeSequence: 7 })
  })

  it('subscribes the gallery tiles to live bot health and unsubscribes on leaving', async () => {
    ws.subscribed.length = 0; ws.unsubscribed.length = 0
    mount({}, false, true)
    await waitFor(() => expect(ws.subscribed).toEqual(expect.arrayContaining(['telegram-inbound', 'slack-inbound', 'discord-inbound'])))
    cleanup()
    expect(ws.unsubscribed).toEqual(expect.arrayContaining(['telegram-inbound', 'slack-inbound', 'discord-inbound']))
  })

  it('shows Jira and TesterArmy together and opens only the selected provider configuration', async () => {
    mount()
    await screen.findByText('Connected')
    expect(screen.getByText('Installed')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Webhooks' })).toBeTruthy()
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

  it('shows status failures on known tiles and retry for the unavailable extension inventory', async () => {
    mount({}, true)
    await waitFor(() => expect(screen.getAllByText('Status unavailable')).toHaveLength(3))
    expect(screen.queryByText('Not connected')).toBeNull()
    expect(screen.queryByText('Not set up')).toBeNull()
    expect(screen.queryByText(/Could not load some integration statuses/)).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Extension integrations could not be loaded')
    expect(screen.getByRole('button', { name: 'Retry extensions' })).toBeTruthy()
  })

  it('says the chat tiles are off on this server when CEZ_WEBHOOKS is off, like the Webhooks tile', async () => {
    const off = { available: false, reason: 'webhooks_off', notifications: { available: false, reason: 'webhooks_off' }, taskControl: { available: false, reason: 'webhooks_off' }, receivers: [], bots: [], grants: [] }
    mount({ '/telegram': off, '/slack': off, '/discord': off })
    for (const name of ['Telegram', 'Slack', 'Discord', 'Webhooks']) {
      await waitFor(() => expect(document.getElementById(`integration-${name.toLowerCase()}-description`)?.textContent).toBe('Status: Off on this server.'))
    }
    expect(screen.queryByText('Not set up')).toBeNull()
  })

  it('filters chat separately from custom webhooks and combines the category with search', async () => {
    mount()
    await screen.findByText('Connected')
    const filter = screen.getByRole('group', { name: 'Integration category' })
    fireEvent.click(within(filter).getByRole('button', { name: /^Chat/ }))
    expect(screen.queryByRole('button', { name: 'Configure Jira' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Configure TesterArmy e2e' })).toBeNull()
    const tiles = screen.getAllByRole('button', { name: /^Configure / }).map(tile => tile.getAttribute('aria-label'))
    expect(tiles).toEqual(['Configure Slack', 'Configure Discord', 'Configure Telegram'])
    expect(screen.queryByRole('button', { name: 'Configure Webhooks' })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations' }), { target: { value: 'jira' } })
    expect(screen.getByRole('status').textContent).toBe('No integrations match “jira”.')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations' }), { target: { value: '' } })
    fireEvent.click(within(filter).getByRole('button', { name: /^Webhooks/ }))
    expect(screen.getAllByRole('button', { name: /^Configure / }).map(tile => tile.getAttribute('aria-label'))).toEqual(['Configure Webhooks'])
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
  fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }))
  fireEvent.click(screen.getByRole('button', { name: /^Notifications only/ }))
  expect(screen.getByText('Slack channel (Incoming Webhook)')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Destination' })).toBeNull()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'All integrations' }))
  fireEvent.click(screen.getByRole('button', { name: 'Configure Discord' }))
  expect(await screen.findByRole('heading', { name: /discord-one/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Connect Discord' }))
  fireEvent.click(screen.getByRole('button', { name: /^Notifications only/ }))
  expect(screen.getByText('Discord channel (Webhook URL)')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Destination' })).toBeNull()
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
  expect(await screen.findByText('No Slack receivers yet')).toBeTruthy()
  expect(screen.queryByText(/Discord/)).toBeNull()
})

it('describes each gallery tile status to assistive technology', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true)
  const slack = await screen.findByRole('button', { name: 'Configure Slack' })
  const descriptionId = slack.getAttribute('aria-describedby')
  expect(descriptionId).toBeTruthy()
  await waitFor(() => expect(document.getElementById(descriptionId!)?.textContent).toContain('1 active'))
})

it('shows a skeleton pill on tiles still loading, announced only through the tile description', async () => {
  mount({ '/webhooks': PENDING }, false, true)
  const webhooks = await screen.findByRole('button', { name: 'Configure Webhooks' })
  expect(webhooks.querySelector('[data-slot="skeleton"]')).toBeTruthy()
  expect(document.getElementById(webhooks.getAttribute('aria-describedby')!)?.textContent).toContain('Status: Loading…')
  expect(within(webhooks).queryByRole('status')).toBeNull()
  expect(within(webhooks).queryByText('Loading…')).toBeNull()
})

it('opens an old Slack receiver settings link even when it lands through the Webhooks card', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true, '/p/alpha/settings/integrations?integration=webhooks&endpoint=slack-one&tab=settings')
  expect(await screen.findByRole('dialog', { name: 'Edit receiver' })).toBeTruthy()
  expect(screen.getByText('Slack channel (Incoming Webhook)')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Destination' })).toBeNull()
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('slack-one')
})

it('never keeps a receiver belonging to another integration in the Webhooks tile', async () => {
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
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.queryByRole('heading', { name: /moved-to-slack/ })).toBeNull()
  const posted = fetch.mock.calls.find(([url, init]) => String(url).endsWith('/webhooks') && init?.method === 'POST')!
  expect(JSON.parse(String(posted[1]?.body)).format).toBe('cezar.json.v1')
})

const E2E_EMPTY = { configFile: null, workflow: false, credentials: [], setup: null }
const REVISION = 'a'.repeat(64)

const TELEGRAM_RECEIVER = {
  id: 'r1', name: 'My bot', format: 'telegram.v1', state: 'active', lastTest: 'success',
  profile: 'standard', preset: 'attention', events: ['task.attention_required'], chatId: '123',
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
    if (/\/(slack|discord)(?:\/|$)/.test(url)) return json({ available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] })
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
    expect(await screen.findByText(/off on this hosted cockpit. Set CEZ_REMOTE_EXTENSIONS=1/)).toBeTruthy()
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
    expect(await screen.findByText('Not running', { selector: '[data-slot="chat-badge"]' })).toBeTruthy()
    cleanup()
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: connectedTelegram('blocked') }))
    renderTab()
    expect(await screen.findByText('Blocked')).toBeTruthy()
  })

  it('reads a starting bot as a neutral Connecting… instead of a red Not running', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: { ...connectedTelegram('stopped'), bots: [{ botId: '123', inboundRevision: REVISION, health: { state: 'stopped', connecting: true } }], grants: [{ id: 'g', receiverId: 'r1', chatId: '123', userId: '456', label: 'Ada', permissions: ['respond'] }] } }))
    renderTab()
    const badge = await screen.findByText('Connecting…', { selector: '[data-slot="chat-badge"]' })
    expect(badge.getAttribute('data-state')).toBe('none')
    expect(screen.queryByText('Not running', { selector: '[data-slot="chat-badge"]' })).toBeNull()
  })

  it.each([
    ['a stopped bot', [{ botId: '123', inboundRevision: REVISION, health: { state: 'stopped' } }], 'Not running'],
    ['a stopped bot beside a blocked one', [{ botId: '123', inboundRevision: REVISION, health: { state: 'stopped' } }, { botId: '456', inboundRevision: REVISION, health: { state: 'blocked' } }], 'Blocked'],
  ])('keeps %s out of a green Connecting… during a background refetch', async (_name, bots, label) => {
    const grants = [{ id: 'g', receiverId: 'r1', chatId: '123', userId: '456', label: 'Ada', permissions: ['respond'] }]
    const settled = mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: { ...connectedTelegram('stopped'), bots, grants } })
    vi.stubGlobal('fetch', settled)
    const client = createQueryClient()
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?integration=telegram']}><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
    const selector = '[data-slot="chat-badge"]'
    expect(await screen.findByText(label, { selector })).toBeTruthy()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => /\/telegram$/.test(String(input)) ? new Promise<Response>(() => {}) : settled(input)))
    const queryKey = ['default', 'telegram-inbound']
    await act(async () => { void client.invalidateQueries({ queryKey }) })
    await waitFor(() => expect(client.isFetching({ queryKey })).toBe(1))
    expect(screen.queryByText('Connecting…', { selector })).toBeNull()
    expect(screen.getByText(label, { selector })).toBeTruthy()
  })

  it('leaves the column and the mobile tab-bar clearance to the settings shell', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER] }))
    renderTab()
    await screen.findByText('Connected', { selector: '[data-slot="chat-badge"]' })
    const wrapper = document.querySelector('[data-slot="telegram-integration"]')!.parentElement!.className
    expect(wrapper).not.toContain('max-w-2xl')
    expect(wrapper).not.toContain('pb-[calc(90px')
  })

  it('reads Notifications only when replies are disabled on every chat of a bot with approved people', async () => {
    const ada = { id: 'g', receiverId: 'r1', chatId: '123', userId: '456', label: 'Ada', permissions: ['respond'] }
    const disabled = { ...connectedTelegram('stopped'), grants: [ada], receivers: [{ receiverId: 'r1', botId: '123', inboundRevision: REVISION, state: 'disabled' }] }
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: disabled }))
    renderTab()
    expect(await screen.findByText('Notifications only', { selector: '[data-slot="chat-badge"]' })).toBeTruthy()
    cleanup()
    // A suspended chat is a fault, not a choice: it still needs attention.
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: { ...disabled, receivers: [{ ...disabled.receivers[0], state: 'suspended' }] } }))
    renderTab()
    expect(await screen.findByText('Not running', { selector: '[data-slot="chat-badge"]' })).toBeTruthy()
    cleanup()
    // Pausing the chat suspends its replies on purpose: notifications only, not a fault.
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [{ ...TELEGRAM_RECEIVER, state: 'paused' }], telegram: { ...disabled, receivers: [{ ...disabled.receivers[0], state: 'suspended' }] } }))
    renderTab()
    expect(await screen.findByText('Notifications only', { selector: '[data-slot="chat-badge"]' })).toBeTruthy()
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

it('offers an existing notification connection before creating a conversation destination', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } }, '/slack': { available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [{ receiverId: 'slack-one', inboundRevision: REVISION }], bots: [], grants: [] } }, false, true, '/?integration=slack')
  const connect = await screen.findByRole('button', { name: 'Connect Slack' })
  await waitFor(() => expect(connect).toHaveProperty('disabled', false))
  fireEvent.click(connect)
  fireEvent.click(screen.getByRole('button', { name: /^Notifications and task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Enable task control for slack-one' }))
  expect(await screen.findByLabelText('Notification name')).toHaveProperty('value', 'slack-one')
  expect(screen.getByText(/no second notification connection is created/)).toBeTruthy()
})
it('still offers notification-only setup when the bot capability is unavailable', async () => {
  mount({ '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } }, '/discord': { available: false, notifications: { available: false, reason: 'hosted' }, taskControl: { available: false, reason: 'hosted' }, receivers: [], bots: [], grants: [] } }, false, true, '/?integration=discord')
  const connect = await screen.findByRole('button', { name: 'Connect Discord' })
  await waitFor(() => expect(connect).toHaveProperty('disabled', false))
  fireEvent.click(connect)
  expect(screen.getByRole('button', { name: /^Notifications and task control/ })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('button', { name: /^Notifications only/ }))
  expect(await screen.findByLabelText('Webhook URL')).toBeTruthy()
})

it('offers repair on the existing Slack chat when token renewal needs attention', async () => {
  const chat = { ...receiver('slack-one', 'slack.v1'), chatId: 'private:T1:U1:D1', state: 'active' }
  mount({ '/webhooks': { receivers: [chat], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } }, '/slack': {
    available: true, notifications: { available: true }, taskControl: { available: true },
    receivers: [{ receiverId: chat.id, botId: 'T1:U1', inboundRevision: REVISION, state: 'credentials-unavailable' }],
    bots: [{ botId: 'T1:U1', inboundRevision: REVISION, health: { state: 'credentials-unavailable' } }], grants: [],
  } }, false, true, '/?integration=slack')
  fireEvent.click(await screen.findByRole('button', { name: `Repair connection for ${chat.name}` }))
  expect(await screen.findByRole('heading', { name: 'Repair Slack connection' })).toBeTruthy()
  expect(screen.getByText(/Repairing access for/).textContent).toContain(chat.name)
  expect(screen.getByText(/no second notification connection is created/)).toBeTruthy()
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', chat.name)
})

const recoveryExtension = (status: 'disabled' | 'starting' | 'failed' | 'running') => ({
  manifest: { id: 'example', name: 'Example', version: '1.0.0', apiVersion: '0.1', entry: 'index.js', capabilities: [], permissions: [],
    contributes: { chatProviders: [{ id: 'chat', label: 'Mattermost', commandPrefix: '!', groupPrefix: 'group:', credentials: [], discoveryUrl: 'https://example.com' }] } },
  source: '/local/example', installedAt: '', enabled: status !== 'disabled', status,
})
describe('installed chat provider recovery', () => {
  it.each(['disabled', 'starting', 'failed'] as const)('retains %s providers and their project-aware recovery detail without worker requests', async status => {
    const { fetch } = mount({ '/extensions/access': { extensions: [recoveryExtension(status)] } })
    const tile = await screen.findByRole('button', { name: 'Configure Mattermost' })
    expect(tile.textContent).toContain(status === 'disabled' ? 'Disabled' : status === 'starting' ? 'Starting' : 'Failed')
    fireEvent.click(tile)
    const detail = await screen.findByRole('region', { name: 'Mattermost' })
    expect(within(detail).getByRole('link', { name: 'Manage extension' }).getAttribute('href')).toBe('/settings/global/extensions?project=alpha&extension=example')
    expect(within(detail).queryByRole('button', { name: 'Connect Mattermost' })).toBeNull()
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/extensions/example/chat/'))).toBe(false)
  })
  it('keeps a bookmarked detail visible when its worker stops', async () => {
    const { client } = mount({ '/extensions/access': { extensions: [recoveryExtension('running')] } }, false, true, '/?integration=example%2Fchat')
    await screen.findByRole('region', { name: 'Mattermost' })
    await act(async () => { client.setQueryData(['extensions', 'alpha', 'list'], { extensions: [recoveryExtension('failed')] }) })
    const detail = await screen.findByRole('region', { name: 'Mattermost' })
    expect(within(detail).getByText('Failed')).toBeTruthy()
    expect(within(detail).getByRole('link', { name: 'Manage extension' })).toBeTruthy()
  })
})

it('keeps saved receiver names in an installed provider recovery detail', async () => {
  mount({
    '/extensions/access': { extensions: [recoveryExtension('disabled')] },
    '/webhooks': { receivers: [receiver('saved-chat', 'example/chat.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } },
  }, false, true, '/?integration=example%2Fchat')
  const detail = await screen.findByRole('region', { name: 'Mattermost' })
  expect(await within(detail).findByText('Saved receivers')).toBeTruthy()
  expect(within(detail).getByText('saved-chat')).toBeTruthy()
})

it('retains missing inventory without access and focuses a cold bookmarked recovery detail', async () => {
  const record = recoveryExtension('disabled')
  const { fetch } = mount({
    '/extensions/access': { extensions: [] },
    '/extensions/inventory': { extensions: [{ record, provenance: { kind: 'bundled', hostVersion: '1', integrity: 'digest' }, availability: 'missing', selectedVersion: '1.0.0', providers: [{ id: 'example/chat', label: 'Mattermost' }] }] },
  }, false, true, '/?integration=example%2Fchat')
  const detail = await screen.findByRole('region', { name: 'Mattermost' })
  expect(within(detail).getByText('Missing')).toBeTruthy()
  expect(document.activeElement).toBe(within(detail).getByRole('heading', { name: 'Mattermost' }))
  expect(within(detail).queryByRole('button', { name: 'Connect Mattermost' })).toBeNull()
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/extensions/example/chat/'))).toBe(false)
})

// Inventory, access and health are independent snapshots: late access must not override recovery.
it.each(['missing', 'flag-disabled', 'hosted', 'disabled', 'failed'] as const)(
  'gates stale running access on affirmative inventory availability: %s', async availability => {
    const record = recoveryExtension('running')
    const inventory = { extensions: [{ record, provenance: { kind: 'folder', source: record.source }, availability, selectedVersion: '1.0.0', providers: [{ id: 'example/chat', label: 'Mattermost' }] }] }
    const { fetch, client } = mount({ '/extensions/access': { extensions: [] }, '/extensions/inventory': inventory }, false, true, '/?integration=example%2Fchat')
    await screen.findByRole('link', { name: 'Manage extension' })
    // Access finishes later, while health still affirms the host capability.
    await act(async () => { client.setQueryData(['extensions', 'alpha', 'list'], { extensions: [record] }) })
    const detail = screen.getByRole('region', { name: 'Mattermost' })
    expect(within(detail).getByRole('link', { name: 'Manage extension' }).getAttribute('href')).toBe('/settings/global/extensions?project=alpha&extension=example')
    expect(within(detail).queryByRole('button', { name: 'Connect Mattermost' })).toBeNull()
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/extensions/example/chat/'))).toHaveLength(0)
    // A second independent access refresh must not resurrect the worker either.
    await act(async () => { client.setQueryData(['extensions', 'alpha', 'list'], { extensions: [{ ...record }] }) })
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/extensions/example/chat/'))).toHaveLength(0)
  },
)

it.each(['telegram', 'slack', 'discord'])('uses canonical %s inventory without a duplicate external tile', async provider => {
  const record = recoveryExtension('disabled')
  mount({ '/extensions/access': { extensions: [] }, '/extensions/inventory': { extensions: [{
    record, provenance: { kind: 'bundled', hostVersion: '1', integrity: 'digest' }, availability: 'disabled', selectedVersion: '1.0.0',
    management: { enable: true, disable: false, update: false, uninstall: false }, providers: [{ id: provider, label: provider }],
  }] } })
  await screen.findByRole('button', { name: 'Configure Slack' })
  const loading = screen.queryByText('Loading extension inventory…')
  if (loading) expect(loading.className).toBe('sr-only')
  await waitFor(() => expect(screen.queryByText('Loading extension inventory…')).toBeNull())
  expect(screen.queryByRole('button', { name: 'Configure Mattermost' })).toBeNull()
  expect(screen.getAllByRole('button', { name: `Configure ${provider[0]!.toUpperCase() + provider.slice(1)}` })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: `Configure ${provider[0]!.toUpperCase() + provider.slice(1)}` }))
  expect((await screen.findByRole('link', { name: 'Manage extension' })).getAttribute('href')).toBe('/settings/global/extensions?project=alpha&extension=example')
})

it('disables Notifications only for an extension provider whose notifications are unavailable', async () => {
  const record = recoveryExtension('running')
  mount({
    '/extensions/access': { extensions: [record] },
    '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } },
    '/extensions/example/chat/chat': { available: true, notifications: { available: false, reason: 'flag_off' }, taskControl: { available: false, reason: 'flag_off' }, receivers: [], bots: [], grants: [] },
  }, false, true, '/?integration=example%2Fchat')
  const connect = await screen.findByRole('button', { name: 'Connect Mattermost' })
  await waitFor(() => expect(connect).toHaveProperty('disabled', false))
  fireEvent.click(connect)
  // It has no webhook fallback, so the choice must not close the dialog onto nothing.
  expect(await screen.findByRole('button', { name: /^Notifications only/ })).toHaveProperty('disabled', true)
})

it('never offers webhook-only receivers for an extension provider, which has no webhook path', async () => {
  const record = recoveryExtension('running')
  mount({
    '/extensions/access': { extensions: [record] },
    '/extensions/example/chat/chat': { available: true, notifications: { available: false, reason: 'webhooks_off' }, taskControl: { available: false, reason: 'webhooks_off' }, receivers: [], bots: [], grants: [] },
  }, false, false, '/?integration=example%2Fchat')
  expect(await screen.findByRole('button', { name: 'Connect Mattermost' })).toBeTruthy()
  expect(screen.queryByText('Webhooks are off')).toBeNull()
})

it('discards unsent external-provider credentials when its worker stops', async () => {
  const running = recoveryExtension('running')
  const declaration = { ...running.manifest.contributes.chatProviders[0]!, credentials: [{ name: 'token', label: 'Fixture access token', secret: true }] }
  const record = { ...running, manifest: { ...running.manifest, contributes: { chatProviders: [declaration] } } }
  const { client } = mount({
    '/extensions/access': { extensions: [record] },
    '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } },
    '/extensions/example/chat/chat': { available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] },
  }, false, true, '/?integration=example%2Fchat')
  const open = async () => {
    const connect = await screen.findByRole('button', { name: 'Connect Mattermost' })
    await waitFor(() => expect(connect).toHaveProperty('disabled', false))
    fireEvent.click(connect)
    fireEvent.click(await screen.findByRole('button', { name: /^Notifications only/ }))
    return screen.findByLabelText('Fixture access token')
  }
  const input = await open()
  fireEvent.change(input, { target: { value: 'unsent-fixture-secret' } })
  await act(async () => { client.setQueryData(['extensions', 'alpha', 'list'], { extensions: [{ ...record, status: 'failed' }] }) })
  await screen.findByRole('link', { name: 'Manage extension' })
  expect(screen.queryByLabelText('Fixture access token')).toBeNull()
  await act(async () => { client.setQueryData(['extensions', 'alpha', 'list'], { extensions: [record] }) })
  expect(await open()).toHaveProperty('value', '')
})

describe('canonical software ownership', () => {
  it.each(['telegram', 'slack', 'discord'])('retains the selected %s replacement owner through unavailable recovery and project switches', async provider => {
    const record = recoveryExtension('disabled')
    const item = { record, provenance: { kind: 'folder', source: record.source }, availability: 'missing', selectedVersion: '1.0.0', providers: [{ id: provider, label: 'Replacement' }] }
    const { switchProject } = mount({
      '/extensions/access': { extensions: [] },
      '/extensions/inventory': { extensions: [item] },
    }, false, true, `/?integration=${provider}`)
    expect((await screen.findByRole('link', { name: 'Manage extension' })).getAttribute('href')).toBe('/settings/global/extensions?project=alpha&extension=example')
    const name = provider[0]!.toUpperCase() + provider.slice(1)
    expect(screen.getAllByRole('region', { name })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'Replacement' })).toBeNull()
    switchProject()
    await waitFor(() => expect(screen.getByRole('link', { name: 'Manage extension' }).getAttribute('href')).toBe('/settings/global/extensions?project=beta&extension=example'))
  })

  it.each(['telegram', 'slack', 'discord'])('does not infer %s ownership from names, manifest declarations or bundled provenance', async provider => {
    const base = recoveryExtension('disabled')
    const record = { ...base, manifest: { ...base.manifest, id: `cezar-chat-${provider}`, name: provider,
      contributes: { chatProviders: [{ ...base.manifest.contributes.chatProviders[0], id: provider, label: provider }] } } }
    const { client } = mount({
      '/extensions/access': { extensions: [record] },
      '/extensions/inventory': { extensions: [{ record, provenance: { kind: 'bundled', hostVersion: '1', integrity: 'digest' }, availability: 'disabled', selectedVersion: '1.0.0',
        providers: [{ id: `${record.manifest.id}/${provider}`, label: provider }] }] },
    }, false, true, `/?integration=${provider}`)
    await waitFor(() => expect(client.getQueryData(['extensions', 'alpha', 'inventory'])).toBeDefined())
    expect(screen.queryByRole('link', { name: 'Manage extension' })).toBeNull()
  })
})

it('gallery panel honors synthetic provider availability guidance', async () => {
  const oldName = telegramDescriptor.name, old = telegramDescriptor.bot.unavailableMessages
  try {
    telegramDescriptor.name = 'Fixture Chat'
    telegramDescriptor.bot.unavailableMessages = { hosted: 'Fixture requires a local socket.', unavailable: 'Fixture temporarily unavailable.' }
    mount({ '/telegram': { available: false, reason: 'hosted', notifications: { available: false, reason: 'hosted' }, taskControl: { available: false, reason: 'hosted' }, receivers: [], bots: [], grants: [] } }, false, true, '/?integration=telegram')
    await screen.findByRole('region', { name: 'Fixture Chat' })
    await waitFor(() => expect(document.body.textContent).toContain('Fixture requires a local socket.'))
  } finally { telegramDescriptor.name = oldName; telegramDescriptor.bot.unavailableMessages = old }
})
