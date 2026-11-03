import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhookTestFeedback } from './webhook-test-feedback'
const api = vi.hoisted(() => ({ deliveries: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function mount(state: string, status: string, reason?: string) {
 api.deliveries.mockResolvedValue({ items: [{ deliveryId: 'test1', status, reason }], receiver: { id: 'r', kind: 'live', state, deliveryRevision: 2, revision: 6, lastTest: 'none' } })
 const open = vi.fn()
 render(<QueryClientProvider client={createQueryClient()}><WebhookTestFeedback projectId="alpha" test={{ deliveryId: 'test1', receiverId: 'r', receiverName: 'Ops', initialState: 'suspended', deliveryRevision: 2 }} openHistory={open} /></QueryClientProvider>)
 return open
}
it('reports current Active state without attributing a competing Pause and Resume to the test', async () => {
 const open = mount('active', 'delivered')
 expect(await screen.findByText('Test delivered.')).toBeTruthy()
 expect(document.querySelector('[data-test-delivery="test1"]')).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: 'View in history' })); expect(open).toHaveBeenCalledWith('r')
})
it('does not claim recovery after receiver was paused', async () => {
 mount('paused', 'delivered')
 expect(await screen.findByText(/Test delivered\. Resume the receiver/)).toBeTruthy()
 expect(screen.queryByText(/recovered to Active/)).toBeNull()
})
it('names the local-network consent a policy-refused test needs, and that activation stays blocked', async () => {
 mount('inactive', 'failed', 'local_consent_required')
 expect(await screen.findByText(/Allow a receiver on this computer or private network/)).toBeTruthy()
 expect(screen.getByText(/Activation stays blocked until a test passes/)).toBeTruthy()
})
it('explains an uncertain test without prompting an automatic resend', async () => {
 mount('suspended', 'failed', 'outcome_unknown')
 expect(await screen.findByText(/Test result unknown/)).toBeTruthy()
 expect(screen.getByText(/Check your receiver before testing again/)).toBeTruthy()
})
it.each([
  ['http_401', /bot token was revoked\. Get a new token from @BotFather and use Add a chat with it for each chat of this bot/],
  ['http_403', /bot was blocked or removed\. Press Start in the private chat, or add the bot back to the group, then test again/],
  ['http_400', /Telegram does not know this chat \(a group may have been upgraded\)\. Remove this chat and connect the group again with Add a chat/],
])('gives a Telegram %s failure its own fix without chat-ID, channel or history wording', async (reason, hint) => {
  api.deliveries.mockResolvedValue({ items: [{ deliveryId: 'test1', status: 'failed', reason }], receiver: { id: 'r', kind: 'live', state: 'active', deliveryRevision: 2, revision: 6, lastTest: 'permanent_failure' } })
  render(<QueryClientProvider client={createQueryClient()}><WebhookTestFeedback projectId="alpha" test={{ deliveryId: 'test1', receiverId: 'r', receiverName: 'Ops', initialState: 'active', deliveryRevision: 2, format: 'telegram.v1' }} /></QueryClientProvider>)
  expect(await screen.findByText(hint)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'View in history' })).toBeNull()
  expect(document.body.textContent).not.toMatch(/chat ID|channel|history/i)
})
function mountTelegram(state: string, status: string, reason?: string) {
  api.deliveries.mockResolvedValue({ items: [{ deliveryId: 'test1', status, reason }], receiver: { id: 'r', kind: 'live', state, deliveryRevision: 2, revision: 6, lastTest: 'none' } })
  render(<QueryClientProvider client={createQueryClient()}><WebhookTestFeedback projectId="alpha" test={{ deliveryId: 'test1', receiverId: 'r', receiverName: 'Ops', initialState: state as 'active', deliveryRevision: 2, format: 'telegram.v1' }} /></QueryClientProvider>)
}
it('never recommends removing the chat after a revoked Telegram token', async () => {
  mountTelegram('active', 'failed', 'http_401')
  expect(await screen.findByText(/use Add a chat with it/)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Remove this chat/)
})
it.each([
  ['inactive', 'delivered', undefined, /Test delivered\. Activate this chat to start sending task updates\./],
  ['paused', 'delivered', undefined, /Test delivered\. Resume this chat to start sending task updates\./],
  ['suspended', 'failed', 'outcome_unknown', /Check the chat before testing again\./],
  ['active', 'failed', 'timeout', /Cezar could not reach Telegram\. Check this computer’s internet connection/],
  ['active', 'failed', 'http_500', /Fix this chat, then send a new test\./],
])('speaks of the chat, never a receiver, for a Telegram test on a %s chat', async (state, status, reason, text) => {
  mountTelegram(state, status, reason)
  expect(await screen.findByText(text)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/receiver/i)
})
it('keeps the receiver wording for a non-Telegram test', async () => {
  mount('inactive', 'delivered')
  expect(await screen.findByText(/Test delivered\. Activate the receiver to start sending task updates\./)).toBeTruthy()
})
