import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ManagerConnectors, ManagerConnectorsResponse } from '@open-mercato/cezar-api-client'

import { ConnectorsDialog, savedConnectors, setConnectorLevel, setConnectorToolOverride } from './manager-connectors'
import { managerFixture } from './manager-fixtures'

const calendar = {
  key: 'claude_ai_Google_Calendar',
  name: 'claude.ai Google Calendar',
  status: 'connected',
  tools: [
    { name: 'list_events', kind: 'read' as const, mode: 'deny' as const },
    { name: 'create_event', kind: 'write' as const, mode: 'deny' as const },
  ],
}
const gmail = { key: 'claude_ai_Gmail', name: 'claude.ai Gmail', status: 'failed', tools: [] }

function stubRoutes(get: ManagerConnectorsResponse, refreshed: ManagerConnectorsResponse = get) {
  const calls: Array<{ url: string; method: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(url.endsWith('/refresh') ? refreshed : get), { status: 200 })
  }))
  return calls
}

function renderDialog(connectors?: ManagerConnectors) {
  const onSave = vi.fn((_: ManagerConnectors) => Promise.resolve())
  const onOpenChange = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ConnectorsDialog manager={managerFixture(connectors ? { connectors } : {})} open onOpenChange={onOpenChange} onSave={onSave} />
    </QueryClientProvider>,
  )
  return { onSave, onOpenChange }
}

// Radix Select scrolls the picked option into view; jsdom has no layout.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('grant edits', () => {
  it('keeps overrides across a level change and drops a cleared override', () => {
    let grants: ManagerConnectors = setConnectorToolOverride({}, 'x', 'send', 'allow')
    expect(grants).toEqual({ x: { level: 'off', tools: { send: 'allow' } } })
    grants = setConnectorLevel(grants, 'x', 'write')
    expect(grants.x).toEqual({ level: 'write', tools: { send: 'allow' } })
    expect(setConnectorToolOverride(grants, 'x', 'send', 'default').x).toEqual({ level: 'write' })
  })

  it('saves without empty off grants', () => {
    expect(savedConnectors({ a: { level: 'off' }, b: { level: 'read' }, c: { level: 'off', tools: { t: 'deny' } } }))
      .toEqual({ b: { level: 'read' }, c: { level: 'off', tools: { t: 'deny' } } })
  })
})

describe('ConnectorsDialog', () => {
  it('lists servers with their status and saves the whole map, unlisted grants included', async () => {
    stubRoutes({ available: true, observedAt: '2026-11-12T10:00:00Z', servers: [calendar, gmail] })
    const { onSave, onOpenChange } = renderDialog({ claude_ai_Drive: { level: 'read' } })
    const row = (await screen.findByText('claude.ai Google Calendar')).closest('li')!
    expect(within(row).getByText('connected')).toBeTruthy()
    const gmailRow = screen.getByText('claude.ai Gmail').closest('li')!
    expect(within(gmailRow).getByText('unavailable')).toBeTruthy()

    fireEvent.click(within(row).getByRole('radio', { name: 'Read+write' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save connectors' }))
    expect(onSave).toHaveBeenCalledWith({ claude_ai_Drive: { level: 'read' }, claude_ai_Google_Calendar: { level: 'write' } })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('shows each tool\'s kind and effective mode, and labels allow on a write tool', async () => {
    stubRoutes({ available: true, servers: [calendar] })
    const { onSave } = renderDialog({ claude_ai_Google_Calendar: { level: 'write' } })
    fireEvent.click(await screen.findByRole('button', { name: '2 tools' }))
    const [read, write] = screen.getAllByRole('listitem').filter((item) => item.dataset.slot === 'manager-connector-tool')
    expect(within(read!).getByText('read')).toBeTruthy()
    expect(within(read!).getByText('Allowed')).toBeTruthy()
    expect(within(write!).getByText('Asks you first')).toBeTruthy()
    // Radix Select in jsdom: open from the keyboard, read or pick the option in the portal.
    const readSelect = within(read!).getByRole('combobox', { name: 'list_events permission' })
    fireEvent.keyDown(readSelect, { key: 'ArrowDown' })
    expect(await screen.findByRole('option', { name: 'allow' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())

    const select = within(write!).getByRole('combobox', { name: 'create_event permission' })
    fireEvent.keyDown(select, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'allow without asking' }))
    expect(within(write!).getByText('Allowed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save connectors' }))
    expect(onSave).toHaveBeenCalledWith({ claude_ai_Google_Calendar: { level: 'write', tools: { create_event: 'allow' } } })
  })

  it('discovers on Refresh from the empty state', async () => {
    const calls = stubRoutes({ available: true, servers: [] }, { available: true, servers: [calendar] })
    renderDialog()
    expect(await screen.findByText('No connectors seen yet — Refresh to discover')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('claude.ai Google Calendar')).toBeTruthy()
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET /api/v1/workspace/managers/global/connectors',
      'POST /api/v1/workspace/managers/global/connectors/refresh',
    ])
  })

  it('explains that only Claude Code managers can use connectors', async () => {
    stubRoutes({ available: false, reason: 'This manager runs on Codex.', servers: [] })
    renderDialog()
    expect(await screen.findByText(/Only Claude Code managers can use connectors\. This manager runs on Codex\./)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
