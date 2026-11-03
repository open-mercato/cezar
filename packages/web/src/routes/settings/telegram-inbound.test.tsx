import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TelegramSetupStatus, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { TelegramChats } from './telegram-chats'
import { TelegramSettings as TelegramInboundPanel, setupBlockers, type TelegramSetupApi } from './telegram-inbound'
const { withLevels } = vi.hoisted(() => {
/** Fills the contract's per-level availability the way the server derives it from `available`/`reason`. */
  const withLevels = (body: any) => body && typeof body === 'object' && 'available' in body ? {
  notifications: body.available || body.reason === 'flag_off' ? { available: true } : { available: false, reason: body.reason ?? 'unavailable' },
  taskControl: body.available ? { available: true } : { available: false, reason: body.reason ?? 'unavailable' },
  ...body,
} : body
  return { withLevels }
})
const mocks = vi.hoisted(() => ({ list: vi.fn(), activity: vi.fn(), permissions: vi.fn(), reset: vi.fn(), disconnect: vi.fn(), bindings: vi.fn(), releaseBinding: vi.fn(), enable: vi.fn(), revoke: vi.fn(), unsubscribe: vi.fn(), subscribe: vi.fn(), listener: undefined as undefined | ((data: unknown) => void),
  webhook: { list: vi.fn(), test: vi.fn(), pause: vi.fn(), resume: vi.fn(), activate: vi.fn(), remove: vi.fn(), update: vi.fn(), deliveries: vi.fn() }, toast: vi.fn() }))
vi.mock('@/api/client', () => ({ telegramApi: { ...mocks, list: (...args: unknown[]) => Promise.resolve(mocks.list(...args)).then(withLevels) }, webhookApi: mocks.webhook }))
vi.mock('@/api/ws', () => ({ subscribeTopic: mocks.subscribe }))
vi.mock('@/components/ui/toaster', async importOriginal => ({ ...await importOriginal<typeof import('@/components/ui/toaster')>(), toast: mocks.toast }))
const receiver: WebhookReceiver = { kind: 'live', destination: 'Telegram chat 456', revision: 1, deliveryRevision: 1, includeScheduledFailures: false, scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, activationBlocked: false, id: 'receiver', name: 'My Telegram', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', telegramChatId: '456', preset: 'attention', events: [] }
const groupReceiver: WebhookReceiver = { ...receiver, id: 'group', name: 'Team group', telegramChatId: '-123' }
const revision = 'a'.repeat(64)
function mount(available = true, configuredReceiver = receiver, activity: { entries: unknown[]; nextCursor?: string } = { entries: [] }, setupApi?: TelegramSetupApi, listed?: unknown) {
  mocks.list.mockResolvedValue(listed ?? { available, reason: available ? undefined : 'flag_off', receivers: [{ receiverId: configuredReceiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }], grants: [], bots: [] })
  mocks.activity.mockResolvedValue(activity)
  mocks.subscribe.mockImplementation((_topic: string, listener: (data: unknown) => void) => { mocks.listener = listener; return mocks.unsubscribe })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><TelegramInboundPanel projectId="project" receivers={[configuredReceiver]} setupApi={setupApi} /></QueryClientProvider>)
}
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.listener = undefined })
const setupRevision = 'b'.repeat(64), setupId = '11111111-1111-4111-8111-111111111111'
function setupMocks(status: 'candidate' | 'expired' = 'candidate', candidate: TelegramSetupStatus['candidate'] = { userId: '456', label: 'Ada', username: 'ada', chatType: 'private' }, receiverId = receiver.id) {
  const api: TelegramSetupApi = {
    begin: vi.fn<TelegramSetupApi['begin']>(async () => ({ setupId, receiverId, bot: { id: '123', username: 'cezar_bot' }, expiresAt: Date.now() + 300000, deepLink: 'https://t.me/cezar_bot?start=one-time' })),
    status: vi.fn<TelegramSetupApi['status']>(async () => ({ status, receiverId, bot: { id: '123', username: 'cezar_bot' }, inboundRevision: setupRevision, ...(status === 'candidate' ? { candidate } : {}) })),
    activate: vi.fn<TelegramSetupApi['activate']>(async () => activated),
    cancel: vi.fn<TelegramSetupApi['cancel']>(async () => ({ cancelled: true })),
  }
  return api
}
const activated = { grant: { id: '22222222-2222-4222-8222-222222222222', receiverId: receiver.id, chatId: '456', userId: '456', label: 'Ada', permissions: ['respond' as const], capability: 'task_control' as const, generation: '33333333-3333-4333-8333-333333333333', enableGeneration: '44444444-4444-4444-8444-444444444444', approvedAt: Date.now() }, inboundRevision: setupRevision }
const grant = (receiverId: string, userId = '456') => ({ ...activated.grant, id: `grant-${receiverId}-${userId}`, receiverId, userId })
/** Open the panel and create the link for the only ready receiver: three clicks. */
async function togglePanel() {
  await waitFor(() => expect(screen.queryByText('Loading Telegram settings…')).toBeNull())
}
/** Approval opens only from a chat's own button. */
async function openApproval(name: RegExp | string = 'Enable task control') {
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name }))
}
async function createLink() {
  await openApproval()
  fireEvent.click(await screen.findByRole('button', { name: 'Create Telegram link' }))
}
it('pairs a private chat in one wizard: choose, link, one Confirm screen, activate', async () => {
  const api = setupMocks(); mount(true, receiver, { entries: [] }, api)
  await openApproval()
  // No mode question, no second pairing path, and no second bot-dedication consent: it was given when the bot was connected.
  expect(screen.queryAllByRole('radio')).toHaveLength(0)
  expect(screen.queryByRole('button', { name: /Pair person|Replace pairing|Start guided setup/ })).toBeNull()
  expect(screen.queryAllByRole('checkbox', { name: /dedicated/ })).toHaveLength(0)
  expect(document.body.textContent).not.toMatch(/older versions|upgrade/i)
  fireEvent.click(screen.getByRole('button', { name: 'Create Telegram link' }))
  expect(api.begin).toHaveBeenCalledWith('project', { receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true })
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('987654321:SENTINEL_TOKEN_MUST_NEVER_RENDER_1234567890')
  const heading = await screen.findByRole('heading', { name: 'Confirm task control' })
  expect(document.activeElement).toBe(heading)
  expect(screen.getByText(/pressed Start in @cezar_bot/).textContent).toBe('Ada (@ada) · Telegram ID 456 pressed Start in @cezar_bot.')
  expect(screen.getByRole('checkbox', { name: 'Start tasks' })).toHaveProperty('checked', false)
  expect(screen.getByRole('checkbox', { name: 'Cancel tasks' })).toHaveProperty('checked', false)
  expect(screen.getByRole('checkbox', { name: 'Continue tasks' })).toHaveProperty('checked', false)
  expect(screen.getByText('Always allowed: answer questions and check task status.')).toBeTruthy()
  expect(screen.getAllByText('Answering, starting and continuing tasks runs the agent and may incur provider costs.')).toHaveLength(1)
  expect(screen.getAllByText(/shell commands on this machine/)).toHaveLength(1)
  expect(screen.queryAllByRole('checkbox', { name: /dedicated/ })).toHaveLength(0)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Start tasks' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Cancel tasks' }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
  expect(await screen.findByText(/Task control is active for Ada/)).toBeTruthy()
  expect(api.activate).toHaveBeenCalledWith('project', setupId, { expectedRevision: setupRevision, candidateUserId: '456', permissions: ['respond', 'start', 'cancel'] })
  expect(screen.queryByRole('button', { name: 'Set up another person' })).toBeNull()
  expect(screen.getByText(/connect their private chat with Add a chat above/)).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(api.cancel).not.toHaveBeenCalled()
  expect(screen.queryByRole('heading', { name: 'Approve a person' })).toBeNull()
})
it('pairs a group member through the same wizard: visibility consent and the comparison code', async () => {
  const api = setupMocks('candidate', { userId: '789', label: 'Grace', chatType: 'private', comparisonCode: '012345' }, groupReceiver.id); mount(true, groupReceiver, { entries: [] }, api)
  await openApproval()
  const create = await screen.findByRole('button', { name: 'Create Telegram link' })
  expect(screen.getByText(/new tasks start only from a private chat\. Forum groups are not supported/)).toBeTruthy()
  expect(create).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /all group members can read project messages/ }))
  fireEvent.click(create)
  expect(api.begin).toHaveBeenCalledWith('project', { receiverId: groupReceiver.id, expectedRevision: revision, dedicatedBot: true, groupVisibilityAccepted: true })
  expect(await screen.findByText('012345')).toBeTruthy()
  // Group members never start tasks, so the group approval does not offer it.
  expect(screen.queryByRole('checkbox', { name: 'Start tasks' })).toBeNull()
  const activate = screen.getByRole('button', { name: 'Activate task control' })
  expect(activate).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /I compared this code/ }))
  fireEvent.click(activate)
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('project', setupId, { expectedRevision: setupRevision, candidateUserId: '789', permissions: ['respond'], comparisonVerified: true }))
  expect(await screen.findByText(/Task control is active for Grace in this group/)).toBeTruthy()
  expect(screen.getByText(/To approve another member of this group, use Approve another member/)).toBeTruthy()
})
it('cancels the server setup session on every wizard exit so abandons never exhaust pairing slots', async () => {
  for (const exit of ['Cancel setup', 'Not this person', 'Exit setup', 'Try again', 'unmount'] as const) {
    const api = setupMocks()
    if (exit === 'Exit setup' || exit === 'Try again') vi.mocked(api.activate).mockRejectedValue(new Error('pairing_changed'))
    const view = mount(true, receiver, { entries: [] }, api)
    await createLink()
    await screen.findByRole('link', { name: 'Open Telegram' })
    if (exit === 'Cancel setup') fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))
    else if (exit === 'unmount') view.unmount()
    else {
      await screen.findByRole('heading', { name: 'Confirm task control' })
      if (exit === 'Not this person') fireEvent.click(screen.getByRole('button', { name: 'Not this person' }))
      else {
        fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
        fireEvent.click(await screen.findByRole('button', { name: exit }))
      }
    }
    await waitFor(() => expect(api.cancel, exit).toHaveBeenCalledWith('project', setupId))
    expect(api.cancel).toHaveBeenCalledTimes(1)
    if (exit !== 'unmount') view.unmount()
    vi.resetAllMocks()
  }
})
it('moves focus to the activating state before completion', async () => {
  let finish!: (value: Awaited<ReturnType<TelegramSetupApi['activate']>>) => void
  const api = setupMocks()
  vi.mocked(api.activate).mockReturnValue(new Promise(resolve => { finish = resolve }))
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  fireEvent.click(await screen.findByRole('button', { name: 'Activate task control' }))
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Activating task control'))
  finish(activated)
})
it('recovers from an expired setup with a keyboard-reachable retry that keeps the receiver', async () => {
  const api = setupMocks('expired'); mount(true, receiver, { entries: [] }, api)
  await createLink()
  expect(await screen.findByText(/This setup link expired/)).toBeTruthy()
  const retry = screen.getByRole('button', { name: 'Try again' }); expect(document.activeElement).toBe(retry)
  const loads = mocks.list.mock.calls.length
  // Focus on the native button is what makes it keyboard-reachable; Enter activates it as a click.
  fireEvent.click(retry)
  expect(await within(screen.getByRole('group', { name: 'Task control in My Telegram' })).findByRole('button', { name: 'Create Telegram link' })).toBeTruthy()
  expect(mocks.list.mock.calls.length).toBeGreaterThan(loads)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})
it('retries a conflicted setup once with the fresh receiver revision, without a manual refresh', async () => {
  const api = setupMocks(), fresh = 'c'.repeat(64); mount(true, receiver, { entries: [] }, api)
  vi.mocked(api.begin).mockRejectedValueOnce(new Error('conflict'))
  await openApproval()
  const create = await screen.findByRole('button', { name: 'Create Telegram link' })
  mocks.list.mockResolvedValue({ available: true, receivers: [{ receiverId: receiver.id, inboundRevision: fresh, state: 'disabled', botId: '123' }], grants: [], bots: [] })
  fireEvent.click(create)
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
  expect(api.begin).toHaveBeenCalledTimes(2)
  expect(api.begin).toHaveBeenLastCalledWith('project', { receiverId: receiver.id, expectedRevision: fresh, dedicatedBot: true })
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})
it('retries a conflict only once; a pairing with another bot is replaced only after explicit confirmation', async () => {
  const api = setupMocks(); mount(true, receiver, { entries: [] }, api)
  vi.mocked(api.begin).mockRejectedValue(new Error('conflict'))
  await createLink()
  expect(await screen.findByText(/Telegram settings changed/)).toBeTruthy()
  expect(api.begin).toHaveBeenCalledTimes(2)
  cleanup(); vi.mocked(api.begin).mockReset().mockRejectedValueOnce(new Error('replacement_required'))
    .mockResolvedValue({ setupId, receiverId: receiver.id, bot: { id: '123', username: 'cezar_bot' }, expiresAt: Date.now() + 300000, deepLink: 'https://t.me/cezar_bot?start=x' })
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  expect((await screen.findByRole('alert')).textContent).toMatch(/bot or chat changed.*removes every approved person/)
  expect(api.begin).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Replace pairing and create link' }))
  await waitFor(() => expect(api.begin).toHaveBeenLastCalledWith('project', { receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true, replaceExisting: true }))
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
})
it('re-pairs a suspended private receiver through explicit replacement instead of a dead end', async () => {
  const api = setupMocks()
  mount(true, receiver, { entries: [] }, api, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], grants: [grant(receiver.id)], bots: [] })
  await openApproval('Replace pairing')
  expect((await screen.findByRole('alert')).textContent).toMatch(/changed since its person was approved.*removes every approved person/)
  expect(api.begin).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Replace pairing and create link' }))
  await waitFor(() => expect(api.begin).toHaveBeenCalledWith('project', { receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true, replaceExisting: true }))
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
})
it('announces validation while begin is pending and ignores its stale completion after cancellation', async () => {
  let finish!: (value: Awaited<ReturnType<TelegramSetupApi['begin']>>) => void
  const api = setupMocks(); vi.mocked(api.begin).mockReturnValue(new Promise(resolve => { finish = resolve }))
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  expect(screen.getByRole('status').textContent).toBe('Checking the saved bot token…')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))
  finish({ setupId, receiverId: receiver.id, bot: { id: '123', username: 'cezar_bot' }, expiresAt: Date.now() + 300000, deepLink: 'https://t.me/cezar_bot?start=stale' })
  // The late session is cancelled on the server, not just ignored here.
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('project', setupId))
  expect(screen.getByRole('button', { name: 'Enable task control' })).toBeTruthy(); expect(screen.queryByRole('link', { name: 'Open Telegram' })).toBeNull()
})
it('lists only the failing conditions of a receiver, each with its fix', async () => {
  expect(setupBlockers(receiver)).toEqual([])
  expect(setupBlockers({ ...receiver, profile: 'minimal', lastTest: 'permanent_failure' })).toEqual(['Send a test and make sure it arrives.', 'Choose Standard message content in this chat’s Options above.'])
  expect(setupBlockers({ ...receiver, state: 'inactive', preset: 'custom', events: ['task.finished'], telegramChatId: '' })).toEqual([
    'Activate this chat’s notifications in Chats above.', 'Remove this chat and connect it again with Add a chat to include the Needs your input event.', 'Remove this chat and connect it again with Add a chat to verify the chat.'])
  expect(setupBlockers({ ...receiver, state: 'paused' })).toEqual(['Resume this chat’s notifications in Chats above.'])
  mount(true, { ...receiver, profile: 'minimal' }, { entries: [] }, setupMocks())
  await openApproval()
  const card = screen.getByRole('group', { name: 'Task control in My Telegram' })
  expect(within(card).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Choose Standard message content in this chat’s Options above.'])
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})
it('says how to recover replies a receiver edit suspended', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], bots: [], grants: [grant(receiver.id)] })
  await togglePanel()
  expect(await screen.findByText(/Replies are suspended because this chat changed\. Use Enable replies once its notifications are active again; if that fails, use Replace pairing/)).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/Use Add a chat to (connect|approve|restore)/)
  expect(screen.getByRole('button', { name: 'Enable replies' })).toHaveProperty('disabled', false)
})
it('does not offer a paired private receiver again but keeps a paired group open for more members', async () => {
  mocks.list.mockResolvedValue({ available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }, { receiverId: groupReceiver.id, inboundRevision: revision, state: 'active', botId: '123' }],
    bots: [], grants: [grant(receiver.id), grant(groupReceiver.id, '789')] })
  mocks.activity.mockResolvedValue({ entries: [] })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[receiver, groupReceiver]} setupApi={setupMocks()} /></QueryClientProvider>)
  await togglePanel()
  const privateChat = await screen.findByRole('group', { name: 'Task control in My Telegram' }), groupChat = screen.getByRole('group', { name: 'Task control in Team group' })
  expect(within(privateChat).queryByRole('button', { name: /Enable task control|Approve/ })).toBeNull()
  expect(within(groupChat).getByRole('button', { name: 'Approve another member' })).toBeTruthy()
  expect(screen.getAllByRole('checkbox', { name: 'Cancel tasks for Ada' })).toHaveLength(2)
  // Starting tasks is a private-chat permission; a group member is never offered it.
  expect(within(privateChat).getByRole('checkbox', { name: 'Start tasks for Ada' })).toHaveProperty('checked', false)
  expect(within(groupChat).queryByRole('checkbox', { name: /Start tasks/ })).toBeNull()
})
it('asks for group visibility on the card before re-enabling a group receiver', async () => {
  mount(true, groupReceiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: groupReceiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }], bots: [], grants: [grant(groupReceiver.id)] })
  mocks.enable.mockResolvedValue({ state: 'active', inboundRevision: revision })
  await togglePanel()
  const card = await screen.findByRole('group', { name: 'Task control in Team group' })
  const enable = await within(card).findByRole('button', { name: 'Enable replies' })
  expect(enable).toHaveProperty('disabled', true)
  fireEvent.click(within(card).getByRole('checkbox', { name: /all group members can read project messages/ }))
  fireEvent.click(enable)
  await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('project', groupReceiver.id, revision, true, true))
})
it('explains how to add a receiver when there are none', async () => {
  mocks.list.mockResolvedValue({ available: true, receivers: [], grants: [], bots: [] }); mocks.activity.mockResolvedValue({ entries: [] })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[]} setupApi={setupMocks()} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByText(/Use Connect Telegram above to connect a bot and chat/)).toBeTruthy()
  expect(screen.getByText(/optionally enable task control/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
  expect(document.body.textContent).not.toMatch(/receiver below/)
})
it('shows a turned-off flag and subscribes to the websocket only when Telegram is available', async () => {
  mount(false)
  await screen.findByRole('article', { name: 'My Telegram' })
  // Notifications need only webhooks: the chat stays manageable with task control off.
  expect(within(screen.getByRole('article', { name: 'My Telegram' })).getByRole('button', { name: 'Send test' })).toBeTruthy()
  expect(screen.queryByText('People and permissions')).toBeNull()
  expect(mocks.subscribe).not.toHaveBeenCalled()
  cleanup(); mount(true)
  await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())
})
it('shows refreshable errors and never approves a candidate without user action', async () => {
  mount(); cleanup(); mocks.list.mockReset().mockRejectedValue(new Error('Unavailable'))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[receiver]} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Telegram is temporarily unavailable. Try again in a moment.')
})

it('requires confirmation before resetting access and sends the displayed bot revision', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'blocked' } }] })
  mocks.reset.mockResolvedValue({ reset: true })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Reset access' }))
  expect(mocks.reset).not.toHaveBeenCalled()
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toMatch(/Notifications keep arriving/)
  expect(dialog.textContent).not.toMatch(/Add a chat/)
  const confirm = within(dialog).getByRole('button', { name: 'Reset access' })
  expect(confirm.getAttribute('data-variant')).toBe('danger-ghost')
  fireEvent.click(confirm)
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledWith('project', '123', revision))
})

it('shows orphan diagnostics on demand and explicitly confirms release', async () => {
  mocks.bindings.mockResolvedValue({ bindings: [{ botId: '123', projectId: 'missing-project', orphaned: true, inboundRevision: revision }], truncated: false })
  mocks.releaseBinding.mockResolvedValue({ released: true })
  mount(); await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Release orphaned bot' }))
  expect(mocks.releaseBinding).not.toHaveBeenCalled()
  expect(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep assignment' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Keep access' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Release bot' }))
  await waitFor(() => expect(mocks.releaseBinding).toHaveBeenCalledWith('123', revision))
})
it('keeps bot reset and assignment diagnostics reachable without outbound receivers', async () => {
  mocks.list.mockResolvedValue({ available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'blocked' } }] })
  mocks.activity.mockResolvedValue({ entries: [] })
  mocks.bindings.mockResolvedValue({ bindings: [{ botId: '456', projectId: 'missing-project', orphaned: true, inboundRevision: revision }], truncated: false })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[]} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByRole('button', { name: 'Reset access' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
  expect(await screen.findByText(/Telegram bot 456/)).toBeTruthy()
})
it('loads older audit entries using the server cursor without losing the first page', async () => {
  const entry = { id: 'new', at: Date.now(), userId: '456', kind: 'answer', state: 'accepted', reason: 'delivered' }
  mount(true, receiver, { entries: [entry], nextCursor: 'older' })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  await screen.findByText(/delivered/)
  mocks.activity.mockResolvedValue({ entries: [{ ...entry, id: 'old', reason: 'older-result' }] })
  fireEvent.click(await screen.findByRole('button', { name: 'Load older actions' }))
  await screen.findByText(/Done: completed/)
  expect(screen.getByText(/Done: delivered/)).toBeDefined()
  expect(mocks.activity).toHaveBeenLastCalledWith('project', expect.any(AbortSignal), 'older')
  expect(screen.queryByRole('button', { name: 'Load older actions' })).toBeNull()
})
it('shows a bot-wide rejection count without attributing it to a person', async () => {
  mount(); mocks.activity.mockResolvedValue({ entries: [{ id: 'summary', kind: 'rejection_summary', at: 60_000, count: 137, reason: 'unauthorized', state: 'rejected' }] })
  mocks.bindings.mockResolvedValue({ bindings: [], truncated: false })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  await screen.findByText(/Bot-wide · 137 rejected messages · not paired/)
  expect(screen.queryByText(/undefined/)).toBeNull()
})

it('maps unavailable reasons, empty receivers and bot poll health to human status text', async () => {
  mount(false)
  await togglePanel()
  // The Telegram section above the panel already names the missing flag once.
  expect(await screen.findByRole('article', { name: 'My Telegram' })).toBeTruthy()
  expect(screen.queryByText(/CEZ_CHAT_INBOUND/)).toBeNull()
  cleanup()
  mocks.list.mockResolvedValue({ available: true, receivers: [], grants: [], bots: [{ botId: '123456789', inboundRevision: revision, health: { state: 'backoff', lastSuccessfulPollAt: 1_760_000_000_000 } }] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><TelegramInboundPanel projectId="project" receivers={[]} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByText('No Telegram receivers yet')).toBeTruthy()
  // Only the health label is live; the poll time beside it changes on every update.
  expect((await screen.findByRole('status')).textContent).toBe('Temporarily retrying')
  expect(screen.getByText(/Last successful poll:/)).toBeTruthy()
})

it('describes activity with the approved person, a short task ID and readable outcomes', async () => {
  const runId = '12345678-abcd-4000-8000-123456789abc', at = Date.now()
  mount(true, receiver, { entries: [
    { id: 'a', at, userId: '456', chatId: '456', runId, kind: 'tasks', state: 'accepted', reason: 'read' },
    { id: 'b', at, userId: '456', chatId: '456', runId, kind: 'continue', state: 'accepted', reason: 'executed' },
    { id: 'c', at, userId: '789', chatId: '456', runId, kind: 'cancel', state: 'rejected', reason: 'permission_denied' },
    { id: 'd', at, userId: '456', chatId: '456', runId, kind: 'task', state: 'accepted', reason: 'task_created' },
    { id: 'e', at, userId: '456', chatId: '456', kind: 'task', state: 'rejected', reason: 'declined' },
    { id: 'g', at, userId: '456', chatId: '456', kind: 'task', state: 'accepted', reason: 'preview' },
    { id: 'f', at, userId: '456', chatId: '456', kind: 'help', state: 'accepted', reason: 'read' },
  ] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], bots: [],
    grants: [{ id: 'grant', receiverId: receiver.id, chatId: '456', userId: '456', label: 'Ada', permissions: ['respond'], capability: 'task_control' }] })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  expect(await screen.findByText(/Ada · Listed tasks · task 12345678 · Done: answered/)).toBeTruthy()
  expect(screen.getByText(/Ada · Continue · task 12345678 · Done: carried out/)).toBeTruthy()
  expect(screen.getByText(/Telegram ID 789 · Cancel · task 12345678 · Refused: no permission for this action/)).toBeTruthy()
  expect(screen.getByText(/Ada · Task request · task 12345678 · Done: task started/)).toBeTruthy()
  expect(screen.getByText(/Ada · Task request · Refused: cancelled before starting/)).toBeTruthy()
  expect(screen.getByText(/Ada · Task request · Done: confirmation sent/)).toBeTruthy()
  expect(screen.queryByText(/Started a task/)).toBeNull()
  expect(screen.getByText(/Ada · Asked for help · Done: answered/)).toBeTruthy()
  expect(screen.queryByText(/unable to complete|123456789abc/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeTruthy()
})
it('shows a reset failure inside the confirmation dialog', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'polling' } }] })
  mocks.reset.mockRejectedValue(new Error('bot_busy'))
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Reset access' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset access' }))
  await waitFor(() => expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('The bot is busy finishing another operation. Try again shortly.'))
})

it.each([receiver, groupReceiver])('asks before replacing a changed chat for $name without requiring an existing grant', async configured => {
  const api = setupMocks('candidate', { userId: '456', label: 'Ada', chatType: 'private' }, configured.id)
  vi.mocked(api.begin).mockRejectedValueOnce(new Error('replacement_required'))
  mount(true, configured, { entries: [] }, api)
  await openApproval()
  const create = await screen.findByRole('button', { name: 'Create Telegram link' })
  const group = configured.telegramChatId!.startsWith('-')
  if (group) fireEvent.click(screen.getByRole('checkbox', { name: /all group members can read project messages/ }))
  fireEvent.click(create)
  expect((await screen.findByRole('alert')).textContent).toMatch(/bot or chat changed/)
  expect(api.begin).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.begin).mock.calls[0]![1].replaceExisting).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: 'Replace pairing and create link' }))
  await waitFor(() => expect(api.begin).toHaveBeenLastCalledWith('project', {
    receiverId: configured.id, expectedRevision: revision, dedicatedBot: true, replaceExisting: true,
    ...(group ? { groupVisibilityAccepted: true } : {}),
  }))
});

it('offers no approval or access-management UI when no bot is connected', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled' }], grants: [], bots: [] })
  await togglePanel()
  expect(screen.queryByText('People and permissions')).toBeNull()
  expect(screen.queryByText('Approve a person')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})

it('offers no approval for a second receiver of a private chat another receiver already controls', async () => {
  const notifications = { ...receiver, id: 'notifications', name: 'Old notifications' }
  mocks.list.mockResolvedValue({ available: true, receivers: [
    { receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' },
    { receiverId: notifications.id, inboundRevision: revision, state: 'disabled', botId: '123' },
  ], grants: [grant(receiver.id)], bots: [] })
  mocks.activity.mockResolvedValue({ entries: [] })
  mocks.subscribe.mockImplementation(() => mocks.unsubscribe)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><TelegramInboundPanel projectId="project" receivers={[receiver, notifications]} setupApi={setupMocks()} /></QueryClientProvider>)
  await togglePanel()
  const card = await screen.findByRole('article', { name: 'Old notifications' })
  expect(within(card).getByText('Same chat as My Telegram, so this chat gets every notification twice. Remove this one.')).toBeTruthy()
  expect(within(card).getByText('Duplicate')).toBeTruthy()
  expect(screen.queryByRole('group', { name: 'Task control in Old notifications' })).toBeNull()
  expect(screen.queryByText('Approve a person')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})
it('does not prompt for another approval after a private chat is already approved', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], grants: [grant(receiver.id)], bots: [] })
  await togglePanel()
  // The approved person is listed with their permissions; nothing asks for another approval.
  expect(await screen.findByText('People and permissions')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Revoke access' })).toBeTruthy()
  expect(screen.queryByText('Approve a person')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})

it('clarifies that an already-approved person needs no further approval', async () => {
  const api = setupMocks()
  vi.mocked(api.activate).mockRejectedValue(new Error('already_paired'))
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  await screen.findByRole('link', { name: 'Open Telegram' })
  await screen.findByRole('heading', { name: 'Confirm task control' })
  fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
  expect(await screen.findByText('This person is already approved for this receiver, so no further approval is needed.')).toBeTruthy()
});

const listed = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ available: true, receivers: rows, grants: [], bots: [], ...extra })
function mountChats(chats: WebhookReceiver[], state: unknown) {
  mocks.list.mockResolvedValue(state); mocks.activity.mockResolvedValue({ entries: [] })
  mocks.subscribe.mockImplementation(() => mocks.unsubscribe)
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={chats} setupApi={setupMocks()} /></QueryClientProvider>)
}
it('gives every Telegram chat, bound to a bot or not, a row with test, pause and a confirmed remove', async () => {
  const unbound = { ...groupReceiver, id: 'unbound', name: 'Old group', telegramChatId: '-999' }
  mocks.webhook.test.mockResolvedValue({ deliveryId: 'd' }); mocks.webhook.pause.mockResolvedValue({}); mocks.webhook.remove.mockResolvedValue({ ok: true })
  mountChats([receiver, unbound], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }]))
  const row = await screen.findByRole('article', { name: 'My Telegram' }), other = screen.getByRole('article', { name: 'Old group' })
  expect(within(row).getByText('Private chat')).toBeTruthy(); expect(within(row).getByText('Notifications: Active')).toBeTruthy()
  expect(within(other).getByText('Group')).toBeTruthy()
  fireEvent.click(within(row).getByRole('button', { name: 'Send test' }))
  await waitFor(() => expect(mocks.webhook.test).toHaveBeenCalledWith('project', receiver.id, { expectedRevision: 1, deliveryRevision: 1, operationId: expect.any(String) }))
  await waitFor(() => expect(within(other).getByRole('button', { name: 'Pause' })).toHaveProperty('disabled', false))
  fireEvent.click(within(other).getByRole('button', { name: 'Pause' }))
  await waitFor(() => expect(mocks.webhook.pause).toHaveBeenCalledWith('project', 'unbound', 1))
  await waitFor(() => expect(within(other).getByRole('button', { name: 'Remove' })).toHaveProperty('disabled', false))
  fireEvent.click(within(other).getByRole('button', { name: 'Remove' }))
  expect(mocks.webhook.remove).not.toHaveBeenCalled()
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove chat' }))
  await waitFor(() => expect(mocks.webhook.remove).toHaveBeenCalledWith('project', 'unbound', 1))
})
it('resumes a paused chat and activates an inactive one only after a passing test', async () => {
  mocks.webhook.resume.mockResolvedValue({})
  mountChats([{ ...receiver, state: 'paused' }, { ...groupReceiver, state: 'inactive', lastTest: 'none' }], listed([]))
  fireEvent.click(within(await screen.findByRole('article', { name: 'My Telegram' })).getByRole('button', { name: 'Resume' }))
  await waitFor(() => expect(mocks.webhook.resume).toHaveBeenCalledWith('project', receiver.id, 1))
  const group = screen.getByRole('article', { name: 'Team group' })
  expect(within(group).getByRole('button', { name: 'Activate' })).toHaveProperty('disabled', true)
  expect(within(group).getByText('Notifications are off. Send a test, then activate.')).toBeTruthy()
})
it('edits content, the agent excerpt and the delay of one chat with its full settings and no token', async () => {
  mocks.webhook.update.mockResolvedValue({ receiver })
  mountChats([{ ...receiver, profile: 'minimal', graceSeconds: 0 }], listed([]))
  const row = await screen.findByRole('article', { name: 'My Telegram' })
  fireEvent.click(within(row).getByRole('button', { name: 'Options' }))
  expect(within(row).queryByRole('checkbox', { name: /excerpt/ })).toBeNull()
  fireEvent.change(within(row).getByLabelText('Message content'), { target: { value: 'standard' } })
  fireEvent.click(within(row).getByRole('checkbox', { name: 'Include an excerpt of the agent’s last message' }))
  fireEvent.change(within(row).getByLabelText(/Notification delay/), { target: { value: '60' } })
  expect(within(row).queryByText(/Saving turns notifications/)).toBeNull()
  fireEvent.click(within(row).getByRole('button', { name: 'Save options' }))
  await waitFor(() => expect(mocks.webhook.update).toHaveBeenCalledWith('project', receiver.id, {
    expectedRevision: 1, format: 'telegram.v1', name: 'My Telegram', profile: 'standard', preset: 'attention', events: [], includeScheduledFailures: false,
    scope: 'main_and_questions', graceSeconds: 60, allowLocalNetwork: false, telegramChatId: '456', includeAgentExcerpt: true }))
  expect(vi.mocked(mocks.webhook.update).mock.calls[0]![2]).not.toHaveProperty('url')
  await waitFor(() => expect(within(row).queryByRole('button', { name: 'Save options' })).toBeNull())
})
it('warns before Minimal content breaks task control in a controlled chat', async () => {
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], { grants: [grant(receiver.id)] }))
  const row = await screen.findByRole('article', { name: 'My Telegram' })
  fireEvent.click(within(row).getByRole('button', { name: 'Options' }))
  fireEvent.change(within(row).getByLabelText('Message content'), { target: { value: 'minimal' } })
  expect(within(row).getByText(/Task control needs Standard content/)).toBeTruthy()
})
it('keeps a notifications-only chat free of any approval form until the user asks for task control', async () => {
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }]))
  const people = await screen.findByRole('group', { name: 'Task control in My Telegram' })
  expect(within(people).getByText('Notifications only')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Approve a person' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
  expect(screen.queryAllByRole('checkbox', { name: /dedicated/ })).toHaveLength(0)
  fireEvent.click(within(people).getByRole('button', { name: 'Enable task control' }))
  expect(await screen.findByRole('heading', { name: 'Approve a person' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('heading', { name: 'Approve a person' })).toBeNull()
})
it('asks for bot dedication only for a chat no bot is bound to yet', async () => {
  const api = setupMocks()
  mocks.list.mockResolvedValue(listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }, { receiverId: 'other', inboundRevision: revision, state: 'disabled' }]))
  mocks.subscribe.mockImplementation(() => mocks.unsubscribe)
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[receiver, { ...receiver, id: 'other', name: 'Other', telegramChatId: '789' }]} setupApi={api} /></QueryClientProvider>)
  const other = await screen.findByRole('group', { name: 'Task control in Other' })
  fireEvent.click(within(other).getByRole('button', { name: 'Enable task control' }))
  const create = within(other).getByRole('button', { name: 'Create Telegram link' })
  expect(create).toHaveProperty('disabled', true)
  fireEvent.click(within(other).getByRole('checkbox', { name: /This bot is dedicated to this project/ }))
  fireEvent.click(create)
  expect(api.begin).toHaveBeenCalledWith('project', { receiverId: 'other', expectedRevision: revision, dedicatedBot: true })
})
it('lets a person be granted and refused the start permission on their row', async () => {
  mocks.permissions.mockResolvedValue({})
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], { grants: [grant(receiver.id)] }))
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Start tasks for Ada' }))
  await waitFor(() => expect(mocks.permissions).toHaveBeenCalledWith('project', grant(receiver.id).id, revision, ['respond', 'start']))
})
it('makes the Send a test blocker actionable from the task-control card', async () => {
  mocks.webhook.test.mockResolvedValue({ deliveryId: 'd' })
  mountChats([{ ...receiver, lastTest: 'transient_failure' }], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], { grants: [grant(receiver.id)] }))
  const people = await screen.findByRole('group', { name: 'Task control in My Telegram' })
  expect(within(people).getByText('Send a test and make sure it arrives.')).toBeTruthy()
  fireEvent.click(within(people).getByRole('button', { name: 'Send test' }))
  await waitFor(() => expect(mocks.webhook.test).toHaveBeenCalledWith('project', receiver.id, expect.objectContaining({ expectedRevision: 1, deliveryRevision: 1 })))
})
it('explains a removed bot and a migrated group with their own fixes', async () => {
  const migrated = { ...groupReceiver, id: 'migrated', name: 'Old team', telegramChatId: '-555' }
  mountChats([groupReceiver, migrated], listed([
    { receiverId: groupReceiver.id, inboundRevision: revision, state: 'suspended', botId: '123', suspendedReason: 'bot_removed' },
    { receiverId: migrated.id, inboundRevision: revision, state: 'suspended', botId: '123', suspendedReason: 'group_migrated' },
  ], { grants: [grant(groupReceiver.id, '789'), grant(migrated.id, '790')] }))
  const removed = await screen.findByRole('group', { name: 'Task control in Team group' }), moved = screen.getByRole('group', { name: 'Task control in Old team' })
  expect(within(removed).getByText(/bot was removed from this group\. Add the bot back to the group, then use Enable replies/)).toBeTruthy()
  expect(within(removed).getByRole('button', { name: 'Enable replies' })).toBeTruthy()
  expect(within(moved).getByText(/upgraded this group and gave it a new chat ID\. Remove this chat in Chats above and connect the group again with Add a chat/)).toBeTruthy()
  expect(within(moved).queryByRole('button', { name: /Enable replies|Approve/ })).toBeNull()
})
it('names the bot by its username when known and confirms Disconnect with a danger button', async () => {
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }], { bots: [{ botId: '123', username: 'cezar_bot', inboundRevision: revision, health: { state: 'polling' } }] }))
  expect(await screen.findByText(/Telegram bot @cezar_bot:/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByRole('button', { name: 'Disconnect and remove chats' }).getAttribute('data-variant')).toBe('danger-ghost')
})
it('points revocation at the chat’s own approval, not at Add a chat', async () => {
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], { grants: [grant(receiver.id)] }))
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke access' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toMatch(/Use Enable task control on the chat to approve them again/)
  expect(dialog.textContent).not.toMatch(/Add a chat/)
})
it('reads task-control availability from its own field when the server sends one', async () => {
  mountChats([receiver], { ...listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }]), taskControl: { available: false, reason: 'flag_off' } })
  expect(await screen.findByRole('article', { name: 'My Telegram' })).toBeTruthy()
  expect(screen.queryByText('People and permissions')).toBeNull()
  expect(screen.queryByText(/CEZ_CHAT_INBOUND/)).toBeNull()
})
it('says Disconnect deletes the bot’s chats, with their count, and names the button for it', async () => {
  mountChats([receiver, groupReceiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }, { receiverId: groupReceiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }],
    { bots: [{ botId: '123', username: 'cezar_bot', inboundRevision: revision, health: { state: 'stopped' } }] }))
  expect(screen.queryByText(/another app that uses this bot/)).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect bot' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toMatch(/This deletes this bot’s 2 chats from this project/)
  expect(dialog.textContent).not.toMatch(/stops notifications/)
  expect(within(dialog).getByRole('button', { name: 'Disconnect and remove chats' })).toBeTruthy()
})
it('tells the operator a blocked private chat is unblocked in Telegram, not by adding the bot to a group', async () => {
  mountChats([receiver, groupReceiver], listed([
    { receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123', suspendedReason: 'bot_removed' },
    { receiverId: groupReceiver.id, inboundRevision: revision, state: 'suspended', botId: '123', suspendedReason: 'bot_removed' },
  ], { grants: [grant(receiver.id), grant(groupReceiver.id, '789')] }))
  const privateChat = await screen.findByRole('group', { name: 'Task control in My Telegram' }), groupChat = screen.getByRole('group', { name: 'Task control in Team group' })
  expect(within(privateChat).getByText('Replies are suspended because the person blocked the bot. After they unblock it in Telegram, use Enable replies.')).toBeTruthy()
  expect(within(privateChat).queryByText(/removed from this group/)).toBeNull()
  expect(within(groupChat).getByText(/bot was removed from this group/)).toBeTruthy()
})
it('asks the private-chat owner to press Start in plain grammar', async () => {
  const api = setupMocks(); vi.mocked(api.status).mockResolvedValue({ status: 'waiting', receiverId: receiver.id, bot: { id: '123', username: 'cezar_bot' }, inboundRevision: setupRevision } as TelegramSetupStatus)
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  expect(await screen.findByText('Waiting for Telegram… Open this link in your private chat with @cezar_bot and press Start.')).toBeTruthy()
})
it('reads a stopped bot as notifications only while nobody is approved, and Not running once someone is', async () => {
  const bots = [{ botId: '123', inboundRevision: revision, health: { state: 'stopped' } }]
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }], { bots }))
  expect(await screen.findByText('Notifications only — not listening for replies')).toBeTruthy()
  cleanup()
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], { bots, grants: [grant(receiver.id)] }))
  expect(await screen.findByText('Not running')).toBeTruthy()
})
it('reads a stopped bot whose chats all have replies disabled as notifications only, without a poll time', async () => {
  const bots = [{ botId: '123', inboundRevision: revision, health: { state: 'stopped' } }]
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }], { bots, grants: [grant(receiver.id)] }))
  expect(await screen.findByText('Notifications only — replies paused or disabled')).toBeTruthy()
  expect(screen.queryByText('Not running')).toBeNull()
  expect(screen.getByText(/Telegram bot/).textContent).not.toMatch(/Last successful poll/)
})
it('reads a paused chat as a deliberate pause, not a changed chat, and hides the poll time of a bot without grants', async () => {
  const bots = [{ botId: '123', inboundRevision: revision, health: { state: 'stopped' } }]
  mountChats([{ ...receiver, state: 'paused' }], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], { bots, grants: [grant(receiver.id)] }))
  expect(await screen.findByText('Replies are paused with this chat’s notifications. Resume it in Chats above.')).toBeTruthy()
  expect(screen.queryByText(/because this chat changed/)).toBeNull()
  expect(screen.getByText('Notifications only — replies paused or disabled')).toBeTruthy()
  cleanup()
  // A suspension the operator did not choose stays a fault.
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], { bots, grants: [grant(receiver.id)] }))
  expect(await screen.findByText(/because this chat changed/)).toBeTruthy()
  cleanup()
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], { bots }))
  expect(await screen.findByText('Notifications only — not listening for replies')).toBeTruthy()
  expect(screen.getByText(/Telegram bot/).textContent).not.toMatch(/Last successful poll/)
})
it('names one chat in the singular and keeps the bot on cancel when disconnecting', async () => {
  mountChats([receiver], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }],
    { bots: [{ botId: '123', username: 'cezar_bot', inboundRevision: revision, health: { state: 'stopped' } }] }))
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect bot' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toMatch(/1 chat from this project \(with its notification options\)/)
  expect(within(dialog).getByRole('button', { name: 'Keep bot' })).toBeTruthy()
  expect(within(dialog).queryByRole('button', { name: 'Keep access' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep bot' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Reset access' }))
  expect(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep access' })).toBeTruthy()
})
it('shows each chat’s own test result and Telegram fix in its row instead of a Check the chat toast', async () => {
  mocks.webhook.test.mockResolvedValue({ deliveryId: 'delivery-1' })
  mocks.webhook.deliveries.mockResolvedValue({ items: [{ deliveryId: 'delivery-1', status: 'failed', reason: 'http_403' }], receiver: { id: receiver.id, kind: 'live', state: 'active', deliveryRevision: 1, revision: 1, lastTest: 'permanent_failure' } })
  mountChats([receiver, groupReceiver], listed([]))
  const row = await screen.findByRole('article', { name: 'My Telegram' })
  fireEvent.click(within(row).getByRole('button', { name: 'Send test' }))
  expect(await within(row).findByText(/Test failed/)).toBeTruthy()
  expect(within(row).getByText(/bot was blocked or removed\. Press Start in the private chat/)).toBeTruthy()
  expect(within(screen.getByRole('article', { name: 'Team group' })).queryByText(/Test failed/)).toBeNull()
  expect(document.body.textContent).not.toMatch(/Check the chat|chat ID|channel|View in history/)
})
it('reads a suspended chat as failed deliveries being retried, not as Telegram refusing it', async () => {
  mountChats([{ ...receiver, state: 'suspended' }], listed([]))
  const row = await screen.findByRole('article', { name: 'My Telegram' })
  expect(within(row).getByText('Recent notifications could not reach Telegram. Cezar retries every 15 minutes; use Send test to check now.')).toBeTruthy()
  expect(row.textContent).not.toMatch(/refusing/)
})
it.each([
  ['invalid_token', 'Telegram rejected the saved bot token. Get a new token from @BotFather and use Add a chat with it.'],
  ['credentials_unavailable', 'The bot token is unavailable or no longer works. Use Add a chat with the bot’s current token.'],
])('points a %s failure at Add a chat with the current token', async (code, text) => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'polling' } }] })
  mocks.reset.mockRejectedValue(new Error(code))
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Reset access' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reset access' }))
  await waitFor(() => expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(text))
  expect(dialog.textContent).not.toMatch(/test the receiver/i)
})
it.each([[1, '1 bot reply was dropped since this bot started.'], [2, '2 bot replies were dropped since this bot started.']])('counts %i dropped bot reply in plain grammar', async (droppedReplies, text) => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'polling', droppedReplies } }] })
  await togglePanel()
  expect((await screen.findByText(/dropped since this bot started/)).textContent).toBe(`${text} Task actions are not retried.`)
})

it.each(['minimal', 'excerpt opt-out'] as const)('keeps the options draft revision when another editor chooses %s', async privacy => {
  const source: WebhookReceiver = { ...receiver, includeAgentExcerpt: true }
  const latest: WebhookReceiver = { ...source, revision: 2, ...(privacy === 'minimal' ? { profile: 'minimal' as const, includeAgentExcerpt: undefined } : { includeAgentExcerpt: undefined }) }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const show = (current: WebhookReceiver) => <QueryClientProvider client={client}><TelegramChats projectId="project" receivers={[current]} controlled={() => false} bound={() => false} /></QueryClientProvider>
  const view = render(show(source))
  fireEvent.click(screen.getByRole('button', { name: 'Options' }))
  fireEvent.change(screen.getByLabelText(/Notification delay/), { target: { value: '60' } })
  view.rerender(show(latest))
  mocks.webhook.update.mockRejectedValueOnce(new Error('conflict'))
  fireEvent.click(screen.getByRole('button', { name: 'Save options' }))
  await waitFor(() => expect(mocks.webhook.update).toHaveBeenCalledWith('project', receiver.id, expect.objectContaining({ expectedRevision: 1, graceSeconds: 60 })))
  await screen.findByRole('alert')
  expect(screen.getByLabelText(/Notification delay/)).toHaveProperty('value', '60')
  fireEvent.click(screen.getByRole('button', { name: 'Reload latest settings' }))
  expect(screen.getByLabelText('Message content')).toHaveProperty('value', latest.profile)
  if (privacy === 'minimal') expect(screen.queryByRole('checkbox', { name: /Include an excerpt/ })).toBeNull()
  else expect(screen.getByRole('checkbox', { name: /Include an excerpt/ })).toHaveProperty('checked', false)
  fireEvent.change(screen.getByLabelText(/Notification delay/), { target: { value: '600' } })
  mocks.webhook.update.mockResolvedValueOnce({ receiver: latest })
  fireEvent.click(screen.getByRole('button', { name: 'Save options' }))
  await waitFor(() => expect(mocks.webhook.update).toHaveBeenLastCalledWith('project', receiver.id, expect.objectContaining({ expectedRevision: 2, profile: latest.profile, graceSeconds: 600 })))
  expect(mocks.webhook.update.mock.calls.at(-1)![2]).not.toHaveProperty('includeAgentExcerpt')
})

it('tells a paused chat without a passing test to send one before resuming', async () => {
  mountChats([{ ...receiver, state: 'paused', lastTest: 'transient_failure' }], listed([]))
  const row = await screen.findByRole('article', { name: 'My Telegram' })
  expect(within(row).getByText(/Send a passing test, then resume\./)).toBeTruthy()
  cleanup()
  mountChats([{ ...receiver, state: 'paused' }], listed([]))
  expect((await screen.findByRole('article', { name: 'My Telegram' })).textContent).not.toMatch(/Send a passing test/)
})
it('confirms Send test with its own notice instead of a settings-updated toast', async () => {
  mocks.webhook.test.mockResolvedValue({ deliveryId: 'd' })
  mountChats([{ ...receiver, lastTest: 'transient_failure' }], listed([{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], { grants: [grant(receiver.id)] }))
  const people = await screen.findByRole('group', { name: 'Task control in My Telegram' })
  fireEvent.click(within(people).getByRole('button', { name: 'Send test' }))
  expect(await screen.findByText('Test sent to My Telegram. Check the chat.')).toBeTruthy()
  expect(mocks.toast).not.toHaveBeenCalledWith('Telegram settings updated')
})
it('reads a bot left without chats as still assigned and offers to release it', async () => {
  mountChats([], listed([], { bots: [{ botId: '123', username: 'cezar_bot', inboundRevision: revision, health: { state: 'stopped' } }] }))
  expect(await screen.findByText('No chats in this project — bot still assigned')).toBeTruthy()
  expect(screen.queryByText(/Notifications only/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect bot' }))
  const dialog = await screen.findByRole('dialog')
  expect(dialog.textContent).toMatch(/This bot has no chats in this project\. Releasing it removes its approved people and reply links and lets another project use it\./)
  expect(dialog.textContent).not.toMatch(/0 chats/)
  expect(within(dialog).getByRole('button', { name: 'Release bot' })).toBeTruthy()
})
it('discloses what the agent excerpt sends as soon as it is ticked', async () => {
  mountChats([receiver], listed([]))
  const row = await screen.findByRole('article', { name: 'My Telegram' })
  fireEvent.click(within(row).getByRole('button', { name: 'Options' }))
  expect(within(row).queryByRole('note')).toBeNull()
  fireEvent.click(within(row).getByRole('checkbox', { name: 'Include an excerpt of the agent’s last message' }))
  expect(within(row).getByRole('note').textContent).toMatch(/Up to 600 characters of what the agent wrote are sent to this chat/)
})
