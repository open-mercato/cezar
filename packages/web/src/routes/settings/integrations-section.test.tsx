import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection } from './integrations-section'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

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

const openTelegramTab = () => fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telegram' }), { button: 0, ctrlKey: false })

describe('External integrations', () => {
  it('opens on the Test frameworks tab with the TesterArmy e2e card', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
    expect(screen.getByRole('tab', { name: 'Test frameworks' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('heading', { name: 'TesterArmy e2e' })).toBeTruthy()
  })

  it('renders Test frameworks tab first and Telegram tab second', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.textContent).toBe('Test frameworks')
    expect(tabs[1]?.textContent).toBe('Telegram')
  })

  it('does not render a separate Telegram task-control entry point', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    await screen.findByRole('heading', { name: 'TesterArmy e2e' })
    expect(screen.getByRole('tab', { name: 'Telegram' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Two-way Telegram' })).toBeNull()
  })

  it('shows Telegram content only in Telegram tab, not in Test frameworks tab', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    expect(screen.getByRole('tab', { name: 'Test frameworks' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('heading', { name: 'TesterArmy e2e' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Telegram' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect Telegram' })).toBeNull()
  })

  it('keeps diagnostics reachable and hides access management when no Telegram receiver is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
    expect(await screen.findByText('Not set up')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy()
    expect(await screen.findByText('No Telegram receivers yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeTruthy()
    expect(screen.queryByText('People and permissions')).toBeNull()
    expect(screen.queryByText('Approve a person')).toBeNull()
  })

  it('shows connected status and access management once a bot is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER] }))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
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
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
    expect(await screen.findByText('Blocked')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('reads Not set up from bot health, not from a configured webhook receiver', async () => {
    const telegram = { available: true, receivers: [{ receiverId: 'r1', inboundRevision: REVISION, state: 'active' }], bots: [], grants: [] }
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram }))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
    expect(await screen.findByText('Not set up')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  const renderTab = () => {
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
    openTelegramTab()
  }
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
