import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TelegramWizard } from './telegram-wizard'
import type { TelegramSetupApi } from './telegram-inbound'

const revision = 'a'.repeat(64)
const activatedRevision = 'b'.repeat(64)
const mocks = vi.hoisted(() => ({ begin: vi.fn(), status: vi.fn(), activate: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/api/client', () => ({ telegramApi: { setup: mocks }, webhookApi: {}, cez: {}, unwrap: vi.fn() }))
vi.mock('./telegram-inbound', () => ({ defaultSetupApi: mocks }))

afterEach(() => { cleanup(); vi.clearAllMocks() })
const token = `123456789:${'A'.repeat(35)}`
const api = mocks
const begun = (id: string, receiverId = 'receiver') => ({ setupId: id, receiverId, bot: { id: '123', username: 'fixture_bot' }, expiresAt: 1, deepLink: `https://t.me/fixture_bot?start=${id}` })

function openWizard() {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

it('starts token-led setup, shows the deep link, polls and activates private notifications', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000001'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person' } })
  api.activate.mockResolvedValue({ inboundRevision: revision })
  openWizard()
  await waitFor(() => expect(screen.getByRole('link', { name: 'Private chat with the bot' }).getAttribute('href')).toBe('https://t.me/fixture_bot?start=00000000-0000-4000-8000-000000000001'))
  expect(api.begin).toHaveBeenCalledWith('alpha', { token, name: 'Telegram notifications', dedicatedBot: true })
  expect(document.body.textContent).not.toContain(token)
  await waitFor(() => expect(screen.getByText(/Connected as/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable task control for this private chat/ }))
  expect(screen.getByText(/No second link is needed/)).toBeTruthy()
  expect(screen.getByText(/agents that run shell commands/)).toBeTruthy()
  expect(screen.getByText(/agents that run shell commands/).textContent).not.toMatch(/cost/)
  expect(screen.getAllByText('Answering, starting and continuing tasks runs the agent and may incur provider costs.')).toHaveLength(1)
  for (const label of ['Start tasks', 'Cancel tasks', 'Continue tasks'])
    expect(screen.getByRole('checkbox', { name: label })).toHaveProperty('checked', false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Continue tasks' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Start tasks' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Cancel tasks' }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications and task control' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), { expectedRevision: revision, candidateUserId: '456', taskControl: true, permissions: ['respond', 'start', 'cancel', 'continue'] }))
  expect(api.begin).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/Telegram setup is complete/).textContent).toContain('task control is enabled')
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(api.cancel).not.toHaveBeenCalled()
})

it('allows group notifications after Start but requires private comparison for task control', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000002', 'temporary-receiver')).mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000003', 'control-receiver'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Group person', chatType: 'group', chatTitle: 'Ops team' } })
  // Activation creates the chat and moves the bot's revision on; the next begin must use the new one.
  api.activate.mockResolvedValueOnce({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' }).mockResolvedValue({ inboundRevision: 'c'.repeat(64) })
  openWizard()
  await waitFor(() => expect(screen.getByText(/Group “Ops team” · started by Group person/)).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), { expectedRevision: revision, candidateUserId: '456', taskControl: false, groupVisibilityAccepted: true }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Telegram notifications are active' })).toBeTruthy())
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person', chatType: 'private', comparisonCode: '123456' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(api.begin).toHaveBeenNthCalledWith(2, 'alpha', { receiverId: 'durable-receiver', expectedRevision: activatedRevision, dedicatedBot: true, groupVisibilityAccepted: true }))
  await waitFor(() => expect(screen.getByText(/Open the private setup link/)).toBeTruthy())
  // Groups cannot start tasks, so the group control step never offers it.
  expect(screen.queryByRole('checkbox', { name: 'Start tasks' })).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'Cancel tasks' })).toBeTruthy()
  const activate = screen.getByRole('button', { name: 'Activate task control' })
  expect(activate).toHaveProperty('disabled', true)
  await waitFor(() => expect(screen.getByText(/Comparison code: 123456/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /compared the code sent privately/ }))
  expect(activate).toHaveProperty('disabled', false)
  fireEvent.click(activate)
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), expect.objectContaining({ taskControl: true, comparisonVerified: true })))
  await waitFor(() => expect(screen.getByText(/Telegram setup is complete/).textContent).toContain('task control is enabled'))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(api.cancel).not.toHaveBeenCalled()
})

it('makes the dedicated-bot consent and unchecked state explicit', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  expect(screen.getByText(/No other application receives its messages/)).toBeTruthy()
  expect(screen.getByText(/must check this to continue/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
})

it('shows a friendly message for an invalid token without echoing the raw code', async () => {
  api.begin.mockRejectedValueOnce(new Error('invalid_token'))
  openWizard()
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(screen.getByRole('alert').textContent).toContain('Telegram rejected this bot token')
  expect(screen.getByRole('alert').textContent).not.toContain('invalid_token')
})

it('shows a friendly message when the person is already paired', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000010'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person' } })
  api.activate.mockRejectedValueOnce(new Error('already_paired'))
  openWizard()
  await waitFor(() => expect(screen.getByText(/Connected as/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable task control for this private chat/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications and task control' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(screen.getByRole('alert').textContent).toContain('already approved for this chat')
  expect(screen.getByRole('alert').textContent).not.toContain('already_paired')
})

it('labels the receiver name field as Notification name and keeps it in the payload', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000020'))
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  expect(screen.queryByLabelText('Bot name')).toBeFalsy()
  fireEvent.change(screen.getByLabelText('Notification name'), { target: { value: 'Ops alerts' } })
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(api.begin).toHaveBeenCalledWith('alpha', expect.objectContaining({ name: 'Ops alerts' })))
})

it('moves keyboard focus to the new step on change', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000030'))
  api.status.mockResolvedValue({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision })
  openWizard()
  await waitFor(() => expect(screen.getByText(/Open one of these links in Telegram/)).toBeTruthy())
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Open one of these links in Telegram'))
})

async function reachGroupCandidate(id: string, chatTitle?: string) {
  api.begin.mockResolvedValueOnce(begun(id))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Group person', chatType: 'group', ...(chatTitle ? { chatTitle } : {}) } })
  openWizard()
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /all members of this group/ })).toBeTruthy())
}

it('offers a private link and an Add to a group link built from the same setup code', async () => {
  api.begin.mockResolvedValueOnce(begun('code_abc'))
  api.status.mockResolvedValue({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision })
  openWizard()
  const groupLink = await screen.findByRole('link', { name: 'Add to a group' })
  expect(groupLink.getAttribute('href')).toBe('https://t.me/fixture_bot?startgroup=code_abc')
  expect(screen.getByRole('link', { name: 'Private chat with the bot' }).getAttribute('href')).toBe('https://t.me/fixture_bot?start=code_abc')
  expect(screen.getByText(/Forum groups \(with topics\) are not supported/)).toBeTruthy()
  expect(screen.getByText(/Press Start there/)).toBeTruthy()
})

it('names the group and asks for the visibility consent once Start arrives from a group', async () => {
  await reachGroupCandidate('00000000-0000-4000-8000-000000000040', 'Ops team')
  expect(screen.getByRole('status').textContent).toBe('Group “Ops team” · started by Group person · Telegram ID 456')
  expect(screen.queryByRole('checkbox', { name: /Enable task control for this private chat/ })).toBeNull()
})

it('does not claim task control after ticking it and then skipping', async () => {
  await reachGroupCandidate('00000000-0000-4000-8000-000000000041')
  api.activate.mockResolvedValueOnce({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' })
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: /Enable optional task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Skip task control' }))
  const done = await screen.findByText(/Telegram setup is complete/)
  expect(done.textContent).not.toContain('task control is enabled')
  expect(done.textContent).toContain('task control is off')
})

it('sets up notifications only and explains the flag when task control is unavailable', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000042'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person', chatType: 'private' } })
  api.activate.mockResolvedValueOnce({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' })
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} taskControlUnavailable="flag_off" />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  const control = await screen.findByRole('checkbox', { name: /Enable task control for this private chat/ })
  expect(control).toHaveProperty('disabled', true)
  expect(screen.getByText(/needs CEZ_CHAT_INBOUND=1/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), { expectedRevision: revision, candidateUserId: '456', taskControl: false }))
  expect(await screen.findByRole('checkbox', { name: /Enable optional task control/ })).toHaveProperty('disabled', true)
})

it.each([
  ['flag_off', /CEZ_CHAT_INBOUND=1/],
  ['webhooks_off', /CEZ_WEBHOOKS=1/],
  ['hosted', /hosted cockpit/],
  ['chat_conflict', /already connected to this bot/],
  ['pairing_limit', /Too many Telegram setups/],
  ['Bot is owned elsewhere or its binding changed.', /connected to another project/],
])('maps the %s setup failure to friendly text', async (message, expected) => {
  api.begin.mockRejectedValueOnce(new Error(message))
  openWizard()
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toMatch(expected)
  if (message.includes('_')) expect(alert.textContent).not.toContain(message)
})

it('shows the token format problem instead of silently disabling Continue', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  const field = screen.getByLabelText('Bot token')
  fireEvent.change(field, { target: { value: 'not-a-token' } })
  expect(screen.getByText(/does not look like a bot token/)).toBeTruthy()
  expect(field.getAttribute('aria-invalid')).toBe('true')
  fireEvent.change(field, { target: { value: token } })
  expect(screen.queryByText(/does not look like a bot token/)).toBeNull()
})

it('proposes a notification name no existing receiver uses', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} existingNames={['Telegram notifications', 'Telegram notifications 2']} />)
  expect((screen.getByLabelText('Notification name') as HTMLInputElement).value).toBe('Telegram notifications 3')
})

it('describes each step and says Cancel setup before anything is active', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000043'))
  api.cancel.mockResolvedValueOnce({ cancelled: true })
  api.status.mockResolvedValue({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision })
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  const first = document.querySelector('[data-slot="dialog-description"]')?.textContent ?? screen.getByText(/created with @BotFather/).textContent
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(await screen.findByText(/Choose the chat that receives notifications/)).toBeTruthy()
  expect(first).not.toContain('Choose the chat')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))
  expect(api.cancel).toHaveBeenCalledWith('alpha', '00000000-0000-4000-8000-000000000043')
})

it('keeps one live region and does not re-render it when a poll returns the same status', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000044'))
    api.status.mockImplementation(async () => ({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision }))
    openWizard()
    const region = await screen.findByRole('status')
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1))
    const observed: MutationRecord[] = []
    const observer = new MutationObserver(records => observed.push(...records))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(3))
    observer.disconnect()
    expect(observed).toHaveLength(0)
    expect(screen.getByRole('status')).toBe(region)
  } finally { vi.useRealTimers() }
})

it('returns to the token step and stops polling when the setup is gone after a restart', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000045'))
    api.status.mockRejectedValue(new Error('pairing_expired'))
    openWizard()
    expect(await screen.findByText('This setup link expired. Start again.')).toBeTruthy()
    await waitFor(() => expect(screen.getByLabelText('Bot token')).toBeTruthy())
    const calls = api.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_100)
    expect(api.status).toHaveBeenCalledTimes(calls)
  } finally { vi.useRealTimers() }
})

async function reachControlStep(id: string) {
  api.begin.mockResolvedValueOnce(begun(`${id}1`)).mockResolvedValueOnce(begun(`${id}2`, 'durable-receiver'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Group person', chatType: 'group', chatTitle: 'Ops team' } })
  api.activate.mockResolvedValueOnce({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' })
  const onComplete = vi.fn()
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} onComplete={onComplete} setupApi={api} />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByText(/Group “Ops team”/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Telegram notifications are active' })).toBeTruthy())
  return onComplete
}

for (const [label, expire] of [
  ['answers 404 pairing_expired', () => api.status.mockRejectedValue(new Error('pairing_expired'))],
  ['reports the link expired', () => api.status.mockResolvedValue({ status: 'expired', receiverId: 'durable-receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision })],
] as const) it(`keeps active notifications when the task-control setup ${label}`, async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    await reachControlStep('00000000-0000-4000-8000-00000000005')
    expire()
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText(/The task-control link expired\. Notifications are on/)).toBeTruthy()
    expect(screen.queryByLabelText('Bot token')).toBeNull()
    expect(screen.queryByText(/Start again/)).toBeNull()
    expect(screen.getByText(/Telegram setup is complete/).textContent).toContain('task control is off')
    const calls = api.status.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_100)
    expect(api.status).toHaveBeenCalledTimes(calls)
  } finally { vi.useRealTimers() }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function startWizard() {
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}
function groupStatus() {
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision,
    candidate: { userId: '456', label: 'Group person', chatType: 'group' } })
  api.activate.mockResolvedValue({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' })
  api.cancel.mockResolvedValue(undefined)
}
async function activateGroup() {
  await screen.findByText(/started by Group person/)
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await screen.findByRole('heading', { name: 'Telegram notifications are active' })
}

it.each(['pairing', 'activation'] as const)('retains group continuation when live receiver names refresh during %s', async phase => {
  groupStatus()
  api.begin.mockResolvedValueOnce(begun('notifications')).mockResolvedValueOnce(begun('control'))
  const props = { projectId: 'alpha', open: true, onOpenChange: vi.fn(), setupApi: api }
  const view = render(<TelegramWizard {...props} existingNames={[]} />)
  startWizard()
  await screen.findByText(/started by Group person/)
  if (phase === 'pairing') view.rerender(<TelegramWizard {...props} existingNames={['Another chat']} />)
  expect(screen.getByRole('heading', { name: 'Connect your Telegram chat' })).toBeTruthy()
  await activateGroup()
  view.rerender(<TelegramWizard {...props} existingNames={['Another chat', 'Telegram notifications']} />)
  expect(screen.getByRole('heading', { name: 'Telegram notifications are active' })).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await screen.findByRole('heading', { name: 'Optional task control' })
  expect(api.begin).toHaveBeenLastCalledWith('alpha', expect.objectContaining({ receiverId: 'durable-receiver', expectedRevision: activatedRevision }))
})

for (const phase of ['notifications', 'control'] as const) {
  for (const leave of ['close', 'unmount', 'project change'] as const) {
    it(`cancels late ${phase} begin against its original project after ${leave}`, async () => {
      groupStatus()
      const pending = deferred<ReturnType<typeof begun>>()
      if (phase === 'control') api.begin.mockResolvedValueOnce(begun('notifications'))
      api.begin.mockReturnValueOnce(pending.promise)
      const props = { projectId: 'alpha', open: true, onOpenChange: vi.fn(), setupApi: api }
      const view = render(<TelegramWizard {...props} />)
      startWizard()
      if (phase === 'control') {
        await activateGroup()
        fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
      }
      if (leave === 'unmount') view.unmount()
      else view.rerender(<TelegramWizard {...props} open={leave !== 'close'} projectId={leave === 'project change' ? 'beta' : 'alpha'} />)
      const polls = api.status.mock.calls.length
      await act(async () => { pending.resolve(begun('late')); await pending.promise })
      expect(api.cancel).toHaveBeenCalledWith('alpha', 'late')
      expect(api.status).toHaveBeenCalledTimes(polls)
      if (leave === 'project change') expect(screen.getByLabelText('Bot token')).toHaveProperty('value', '')
    })
  }
}

it('cancels an unconsumed pairing on unmount', async () => {
  groupStatus(); api.begin.mockResolvedValueOnce(begun('pending'))
  const view = render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  startWizard()
  await screen.findByText(/started by Group person/)
  view.unmount()
  expect(api.cancel).toHaveBeenCalledWith('alpha', 'pending')
})

it('ignores activation results from a previous project session', async () => {
  groupStatus(); api.begin.mockResolvedValueOnce(begun('pending'))
  const pending = deferred<{ inboundRevision: string }>()
  api.activate.mockReturnValueOnce(pending.promise)
  const props = { open: true, onOpenChange: vi.fn(), onComplete: vi.fn(), setupApi: api }
  const view = render(<TelegramWizard {...props} projectId="alpha" />)
  startWizard()
  await screen.findByText(/started by Group person/)
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  view.rerender(<TelegramWizard {...props} projectId="beta" />)
  await act(async () => { pending.resolve({ inboundRevision: activatedRevision }); await pending.promise })
  expect(screen.getByRole('heading', { name: 'Connect Telegram' })).toBeTruthy()
  expect(props.onComplete).not.toHaveBeenCalled()
})

it('ignores a late poll from a previous project and starts the new project with a fresh form', async () => {
  groupStatus(); api.begin.mockResolvedValueOnce(begun('pending'))
  const pending = deferred<{ status: string; inboundRevision: string }>()
  api.status.mockReturnValueOnce(pending.promise)
  const props = { open: true, onOpenChange: vi.fn(), setupApi: api }
  const view = render(<TelegramWizard {...props} projectId="alpha" />)
  startWizard()
  await screen.findByRole('heading', { name: 'Connect your Telegram chat' })
  view.rerender(<TelegramWizard {...props} projectId="beta" />)
  await act(async () => { pending.resolve({ status: 'expired', inboundRevision: revision }); await pending.promise })
  expect(screen.getByRole('heading', { name: 'Connect Telegram' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(api.status).toHaveBeenCalledTimes(1)
})


it.each(['begin', 'approve'] as const)('preserves task-control truth after a late %s response', async phase => {
  groupStatus()
  const pendingBegin = deferred<ReturnType<typeof begun>>()
  const pendingApprove = deferred<{ inboundRevision: string }>()
  api.begin.mockResolvedValueOnce(begun('notifications'))
  if (phase === 'begin') api.begin.mockReturnValueOnce(pendingBegin.promise)
  else api.begin.mockResolvedValueOnce(begun('control'))
  const onComplete = vi.fn()
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} onComplete={onComplete} setupApi={api} />)
  startWizard()
  await activateGroup()
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'durable-receiver', inboundRevision: activatedRevision,
    candidate: { userId: '456', label: 'Private person', chatType: 'private', comparisonCode: '123456' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(api.begin).toHaveBeenLastCalledWith('alpha', expect.objectContaining({ receiverId: 'durable-receiver' }))
  if (phase === 'approve') {
    fireEvent.click(await screen.findByRole('checkbox', { name: /compared the code sent privately/ }))
    api.activate.mockReturnValueOnce(pendingApprove.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
    expect(api.activate).toHaveBeenLastCalledWith('alpha', 'control', expect.objectContaining({ taskControl: true }))
  }
  const skip = screen.getByRole('button', { name: 'Skip task control' }) as HTMLButtonElement
  expect(skip.disabled).toBe(phase === 'approve')
  fireEvent.click(skip)
  expect(screen.getByRole('heading', { name: phase === 'approve' ? 'Optional task control' : 'Telegram is ready' })).toBeTruthy()
  const completions = onComplete.mock.calls.length
  const polls = api.status.mock.calls.length
  await act(async () => {
    if (phase === 'begin') { pendingBegin.resolve(begun('late-control')); await pendingBegin.promise }
    else { pendingApprove.resolve({ inboundRevision: revision }); await pendingApprove.promise }
  })
  expect(screen.getByRole('heading', { name: 'Telegram is ready' })).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain(phase === 'approve'
    ? 'Notifications are active and task control is enabled'
    : 'Notifications are active; task control is off')
  expect(onComplete).toHaveBeenCalledTimes(completions + (phase === 'approve' ? 1 : 0))
  expect(api.status).toHaveBeenCalledTimes(polls)
  if (phase === 'begin') expect(api.cancel).toHaveBeenCalledExactlyOnceWith('alpha', 'late-control')
  else expect(api.cancel).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(api.cancel).toHaveBeenCalledTimes(phase === 'begin' ? 1 : 0)
})

it('preserves approval success across consumed-status polling', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    groupStatus()
    const pending = deferred<{ inboundRevision: string }>()
    api.begin.mockResolvedValueOnce(begun('notifications')).mockResolvedValueOnce(begun('control'))
    render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
    startWizard()
    await activateGroup()
    api.status.mockResolvedValue({ status: 'candidate', receiverId: 'durable-receiver', inboundRevision: revision,
      candidate: { userId: '456', label: 'Private person', chatType: 'private', comparisonCode: '123456' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /compared the code sent privately/ }))
    api.activate.mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
    expect(screen.getByRole('button', { name: 'Skip task control' })).toHaveProperty('disabled', true)
    // Backend has consumed the approved setup, but the activation response is delayed.
    api.status.mockRejectedValue(new Error('pairing_expired'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    await act(async () => { pending.resolve({ inboundRevision: revision }); await pending.promise })
    expect(screen.getByRole('status').textContent).toContain('Notifications are active and task control is enabled')
  } finally { vi.useRealTimers() }
})

it.each(['success', 'failure'] as const)('ignores pre-approval status replies after approval %s', async outcome => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    groupStatus()
    const approval = deferred<{ inboundRevision: string }>()
    const statusReply = deferred<Awaited<ReturnType<TelegramSetupApi['status']>>>()
    api.begin.mockResolvedValueOnce(begun('notifications')).mockResolvedValueOnce(begun('control'))
    render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
    startWizard()
    await activateGroup()
    api.status.mockResolvedValue({ status: 'candidate', receiverId: 'durable-receiver', inboundRevision: revision,
      candidate: { userId: '456', label: 'Private person', chatType: 'private', comparisonCode: '123456' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: /compared the code sent privately/ }))
    api.status.mockReturnValueOnce(statusReply.promise)
    await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
    api.activate.mockReturnValueOnce(approval.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
    if (outcome === 'failure') {
      await act(async () => { approval.reject(new Error('Try approval again')); await approval.promise.catch(() => undefined) })
    }
    await act(async () => { statusReply.reject(new Error('pairing_expired')); await statusReply.promise.catch(() => undefined) })
    expect(screen.getByRole('heading', { name: 'Optional task control' })).toBeTruthy()
    if (outcome === 'success') {
      await act(async () => { approval.resolve({ inboundRevision: revision }); await approval.promise })
      expect(screen.getByRole('status').textContent).toContain('Notifications are active and task control is enabled')
    } else {
      expect(screen.getByRole('button', { name: 'Activate task control' })).toHaveProperty('disabled', false)
      expect(screen.getByRole('button', { name: 'Skip task control' })).toHaveProperty('disabled', false)
      api.status.mockRejectedValue(new Error('pairing_expired'))
      await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
      expect(screen.getByRole('status').textContent).toContain('Notifications are active; task control is off')
    }
  } finally { vi.useRealTimers() }
})

it('keeps the setup open while notifications are activating', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000009'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person', chatType: 'private' } })
  let finish: (value: { inboundRevision: string }) => void = () => undefined
  api.activate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  openWizard()
  await waitFor(() => expect(screen.getByText(/Connected as/)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalled())
  expect(screen.getByRole('button', { name: 'Cancel setup' })).toHaveProperty('disabled', true)
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(api.cancel).not.toHaveBeenCalled()
  await act(async () => { finish({ inboundRevision: activatedRevision }) })
  expect(await screen.findByRole('heading', { name: 'Telegram notifications are active' })).toBeTruthy()
  expect(api.cancel).not.toHaveBeenCalled()
})
