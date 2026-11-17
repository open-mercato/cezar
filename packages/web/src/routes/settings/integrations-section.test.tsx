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
const PENDING = Symbol('pending')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function mount(overrides: Record<string, unknown> = {}, offline = false, enabled = false, initialEntry = '/') {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (offline) return json({ error: 'Offline' }, 503)
    const url = String(input)
    const suffix = Object.keys(overrides).find(key => url.endsWith(key))
    if (suffix) return overrides[suffix] === PENDING ? new Promise<Response>(() => {}) : json(overrides[suffix])
    if (url.endsWith('/tracker/association')) return json({ association: jira })
    if (url.endsWith('/tracker/connection')) return json({ connection, demo: false })
    if (url.endsWith('/e2e')) return json(installed)
    return json({ error: 'Unexpected request' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  for (const project of ['alpha', 'beta']) client.setQueryData([project, 'health'], { capabilities: { webhooks: enabled, localHandoff: true } })
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

  it('keeps deleted receivers, which carry no format yet, on the Webhooks tile', async () => {
    const history = [{ kind: 'history', id: 'deleted-0', name: 'Deleted receiver', deletedAt: '2026-11-04T12:00:00Z' }]
    mount({ '/webhooks': { receivers: [], history, historyCount: 1, changeSequence: 0, webhookHealth: { status: 'ready' } }, '/webhooks/history?limit=100': { items: history, total: 1, hasMore: false } }, false, true, '/?integration=webhooks')
    fireEvent.click(await screen.findByRole('button', { name: 'Show deleted receivers' }))
    expect(await screen.findByRole('button', { name: /Deleted receiver/ })).toBeTruthy()
  })

  it.each([['webhooks', 'Your own HTTPS endpoint (signed JSON)'], ['slack', 'Slack channel (Incoming Webhook)'], ['discord', 'Discord channel (Webhook URL)']])('locks the %s add form to its own destination', async (integration, label) => {
    mount({ '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true, `/?integration=${integration}`)
    const add = await screen.findByRole('button', { name: 'Add receiver' })
    await waitFor(() => expect(add).toHaveProperty('disabled', false))
    fireEvent.click(add)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('combobox', { name: 'Destination' })).toBeNull()
    expect(within(dialog).getByText(label)).toBeTruthy()
    if (integration === 'webhooks') {
      fireEvent.change(within(dialog).getByLabelText('Receiver URL'), { target: { value: 'https://hooks.slack.com/services/TA/BB/secret' } })
      expect(within(dialog).queryByRole('button', { name: 'Use Slack' })).toBeNull()
      expect(within(dialog).getByText(/Integrations → Slack/)).toBeTruthy()
    }
  })

  it.each(['webhooks', 'slack', 'discord'])('shows a %s change notice only in its integration', async integration => {
    const format = integration === 'webhooks' ? 'cezar.json.v1' : `${integration}.v1`
    const notice = { changeSequence: 7, at: '2026-11-04T12:00:00Z', action: 'activated', receiverId: 'changed', receiverName: 'Changed receiver', source: 'cockpit/api' }
    mount({ '/webhooks': { receivers: [receiver('changed', format)], history: [], historyCount: 0, changeSequence: 7, webhookHealth: { status: 'ready' }, notice } }, false, true)
    for (const name of ['Webhooks', 'Slack', 'Discord']) {
      fireEvent.click(await screen.findByRole('button', { name: `Configure ${name}` }))
      await screen.findByRole('region', { name })
      if (name.toLowerCase() === integration) expect(await screen.findByRole('button', { name: 'Mark as reviewed' })).toBeTruthy()
      else expect(screen.queryByRole('button', { name: 'Mark as reviewed' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'All integrations' }))
    }
  })

  it('shows Jira and TesterArmy together and opens only the selected provider configuration', async () => {
    mount()
    await screen.findByText('Connected')
    expect(screen.getByText('Installed')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Chat' })).toBeNull()
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

  it('shows status failures on known tiles without a gallery-wide alert', async () => {
    mount({}, true)
    await waitFor(() => expect(screen.getAllByText('Status unavailable')).toHaveLength(3))
    expect(screen.queryByText('Not connected')).toBeNull()
    expect(screen.queryByText('Not set up')).toBeNull()
    expect(screen.queryByText(/Could not load some integration statuses/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says the Slack, Discord and Webhooks tiles are off on this server when CEZ_WEBHOOKS is off', async () => {
    mount()
    for (const name of ['Slack', 'Discord', 'Webhooks']) {
      await waitFor(() => expect(document.getElementById(`integration-${name.toLowerCase()}-description`)?.textContent).toBe('Status: Off on this server.'))
    }
    expect(screen.queryByText('Not set up')).toBeNull()
  })

  it('filters the gallery by category and combines the category with search', async () => {
    mount()
    await screen.findByText('Connected')
    const filter = screen.getByRole('group', { name: 'Integration category' })
    expect(within(filter).queryByRole('button', { name: /^Chat/ })).toBeNull()
    fireEvent.click(within(filter).getByRole('button', { name: /^Webhooks/ }))
    expect(screen.queryByRole('button', { name: 'Configure Jira' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Configure TesterArmy e2e' })).toBeNull()
    const tiles = screen.getAllByRole('button', { name: /^Configure / }).map(tile => tile.getAttribute('aria-label'))
    expect(tiles).toEqual(['Configure Slack', 'Configure Discord', 'Configure Webhooks'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations' }), { target: { value: 'jira' } })
    expect(screen.getByRole('status').textContent).toBe('No integrations match “jira”.')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations' }), { target: { value: '' } })
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
  expect(screen.getByText('Slack channel (Incoming Webhook)')).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Destination' })).toBeNull()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'All integrations' }))
  fireEvent.click(screen.getByRole('button', { name: 'Configure Discord' }))
  expect(await screen.findByRole('heading', { name: /discord-one/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
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
  expect(await screen.findByText('No receivers yet')).toBeTruthy()
  expect(screen.getByText(/Add a Slack channel through its Incoming Webhook URL/)).toBeTruthy()
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
