import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { withOwnWebhookChange } from '@/lib/own-webhook-changes'
import { IntegrationsSection } from './integrations-section'

vi.mock('@/api/ws', async importOriginal => ({ ...await importOriginal<typeof import('@/api/ws')>(), subscribeTopic: () => () => undefined }))
afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

// Own-tab state is module-wide, so this file keeps its single scenario apart from integrations-section.test.tsx.
it('does not show this tab’s own chat activation as a change to review', async () => {
  const notice = { changeSequence: 8, at: '2026-11-17T12:00:00Z', action: 'activated', receiverId: 'mine', receiverName: 'My chat', destination: 'Telegram chat 1', format: 'telegram.v1', source: 'cockpit/api' }
  let list: unknown = { receivers: [], history: [], historyCount: 0, changeSequence: 7, webhookHealth: { status: 'ready' } }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/webhooks')) return json(list)
    if (url.includes('/health')) return json({ version: '1.0.0', capabilities: { webhooks: true, extensions: true, localHandoff: true } })
    if (url.includes('/extensions')) return json({ extensions: [] })
    if (/\/(telegram|slack|discord)$/.test(url)) return json({ available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] })
    if (url.endsWith('/e2e')) return json({ configFile: null, workflow: false, credentials: [], setup: null })
    return json({})
  }))
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false } })
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/?integration=telegram']}><ProjectScopeProvider projectId="alpha"><IntegrationsSection /></ProjectScopeProvider></MemoryRouter></QueryClientProvider>)
  await screen.findByRole('region', { name: 'Telegram' })
  await waitFor(() => expect(client.getQueryData(['alpha', 'webhooks'])).toBeTruthy())
  // The wizard's activation: the server records it and opens a notice for the receiver.
  await withOwnWebhookChange(client, 'alpha', ['mine'], async () => { list = { ...(list as object), changeSequence: 8, notice }; return {} })
  await waitFor(() => expect(client.getQueryData<{ changeSequence: number }>(['alpha', 'webhooks'])?.changeSequence).toBe(8))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(screen.queryByRole('button', { name: 'Mark as reviewed' })).toBeNull()
  // A later change from elsewhere still raises it.
  list = { ...(list as object), changeSequence: 9, notice: { ...notice, changeSequence: 9, action: 'paused' } }
  await client.invalidateQueries({ queryKey: ['alpha', 'webhooks'] })
  expect(await screen.findByRole('button', { name: 'Mark as reviewed' })).toBeTruthy()
})
