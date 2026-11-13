import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WebhookReceiver } from '@open-mercato/cezar-api-client'
import { ChatSettings } from './chat-inbound'
import { fixtureProvider } from './chat-provider-fixture'
import { ChatList } from './chat-list'

const mocks = vi.hoisted(() => ({
  test: vi.fn(), list: vi.fn(), subscribe: vi.fn(() => () => {}),
  begin: vi.fn(), status: vi.fn(), cancel: vi.fn(async () => ({})), activate: vi.fn(),
}))
vi.mock('@/api/client', () => ({ telegramApi: {}, webhookApi: { test: mocks.test }, cez: {}, unwrap: vi.fn() }))
vi.mock('@/api/ws', () => ({ subscribeTopic: mocks.subscribe }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
const provider = {
  ...fixtureProvider,
  bot: {
    ...fixtureProvider.bot,
    api: { ...fixtureProvider.bot.api, list: mocks.list }, subscribe: mocks.subscribe,
    validChatId: () => true, isGroup: () => false,
    privateHint: 'Mention Fixture to approve yourself.',
    discoveryCommand: () => '/start APPROVE-PERSON',
    setupErrorMessages: { invalid_token: 'Renew Fixture credential.' },
    setupApi: { begin: mocks.begin, status: mocks.status, cancel: mocks.cancel, activate: mocks.activate },
  },
}
const receiver: WebhookReceiver = {
  kind: 'live', destination: 'Fixture DM', includeScheduledFailures: false, scope: 'main_and_questions',
  graceSeconds: 180, allowLocalNetwork: false, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
  pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, activationBlocked: false,
  id: 'r', name: 'Fixture receiver', format: 'slack.v1', state: 'active', lastTest: 'success',
  profile: 'standard', preset: 'attention', events: [], chatId: 'DM-A', revision: 1, deliveryRevision: 1,
}
function mount(receivers: WebhookReceiver[] = []) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ChatSettings provider={provider} projectId="p" receivers={receivers} />
  </QueryClientProvider>)
}
const state = { available: true, notifications: { available: true }, taskControl: { available: true }, bots: [], grants: [], receivers: [] }
it('empty settings uses provider connection instruction', async () => {
  mocks.list.mockResolvedValue(state); mount()
  await screen.findByText('No Fixture Chat receivers yet')
  expect(document.body.textContent).not.toContain('Connect Telegram')
})
it('settings honors descriptor error guidance', async () => {
  mocks.list.mockRejectedValue(new Error('invalid_token')); mount()
  expect((await screen.findByRole('alert')).textContent).toBe('Renew Fixture credential.')
})
it('settings never renders raw provider error secret', async () => {
  mocks.list.mockRejectedValue(new Error('Credential rejected: fixture-secret-123')); mount()
  expect((await screen.findByRole('alert')).textContent).not.toContain('fixture-secret-123')
})
it('existing receiver approval uses descriptor discovery instruction', async () => {
  mocks.list.mockResolvedValue({ ...state, receivers: [{ receiverId: 'r', botId: 'BOT-A', state: 'disabled', inboundRevision: 'revision' }] })
  mocks.begin.mockResolvedValue({ setupId: 's', bot: { username: 'fixture' }, deepLink: 'https://example.invalid' })
  mocks.status.mockResolvedValue({ status: 'waiting' })
  mount([receiver])
  fireEvent.click(await screen.findByRole('button', { name: 'Enable task control' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create Fixture Chat link' }))
  await screen.findByRole('link', { name: 'Open Fixture Chat' })
  expect(screen.getByLabelText('Command for private chat')).toHaveProperty('value', '/start APPROVE-PERSON')
  expect(document.body.textContent).toContain('Mention Fixture to approve yourself.')
  expect(document.body.textContent).not.toContain('press Start')
})
it.each(['slack_invalid_token', 'slack-invalid_token', 'slack invalid_token'])('normalizes provider error %s', async code => {
  mocks.list.mockRejectedValue(new Error(code)); mount()
  expect((await screen.findByRole('alert')).textContent).toBe('Renew Fixture credential.')
})
it.each(['Credential rejected: fixture-secret-123', 'unknown_code', 'constructor', 'toString'])('chat actions hide unknown server detail %s', async detail => {
  mocks.test.mockRejectedValue(new Error(detail))
  render(<QueryClientProvider client={new QueryClient()}>
    <ChatList provider={provider} projectId="p" receivers={[receiver]} controlled={() => false} bound={() => false} />
  </QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Fixture Chat could not complete that action. Refresh and try again.')
})
