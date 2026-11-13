import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatWizard } from './chat-wizard'
import { telegramDescriptor } from '@/lib/chat-providers/telegram'
import { fixtureProvider, withSetupApi } from './chat-provider-fixture'

const api = vi.hoisted(() => ({ begin: vi.fn(), status: vi.fn(), activate: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/client', () => ({ telegramApi: { setup: api }, webhookApi: {}, cez: {}, unwrap: vi.fn() }))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  api.cancel.mockResolvedValue(undefined)
  api.begin.mockResolvedValue({ setupId: 'setup', receiverId: 'receiver', deepLink: 'https://example.invalid/setup' })
  api.status.mockResolvedValue({ status: 'candidate', inboundRevision: 'revision', candidate: { userId: 'person', label: 'Person', chatType: 'private' } })
})
// Synthetic descriptor only; no second platform transport is implemented.
const provider = {
  ...telegramDescriptor, id: 'slack' as const, name: 'Fixture Chat', format: 'slack.v1' as const,
  bot: {
    ...telegramDescriptor.bot,
    fields: [{ name: 'token', label: 'Fixture credential', placeholder: 'fixture-', pattern: /^fixture-/, invalid: 'Invalid fixture credential' }],
    credentialHint: 'Fixture credentials', help: { label: 'Fixture console', href: 'https://example.invalid' },
    setupErrorMessages: {
      invalid_token: 'Generate a new credential in the Fixture console.',
      group_ineligible: 'Invite the fixture app to an eligible channel.',
      bot_conflict: 'Release the fixture app from its other workspace.',
    },
    unavailableMessages: { hosted: 'Use the fixture app locally.', unavailable: 'Fixture control is unavailable.' },
  },
}
const { approval, groupRestriction, credentialHelp, settingsErrorMessages } = fixtureProvider.bot
const mentionProvider = { ...provider, bot: { ...provider.bot, approval, groupRestriction, credentialHelp, settingsErrorMessages } }
function open(descriptor = provider) {
  render(<ChatWizard provider={withSetupApi(descriptor, api)} projectId="p" open onOpenChange={vi.fn()} />)
}
function start() {
  fireEvent.change(screen.getByLabelText('Fixture credential'), { target: { value: 'fixture-secret' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}
it('uses the descriptor for the default notification name', () => {
  open()
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Fixture Chat notifications')
})
it('deduplicates the provider name and resets it on reopening', () => {
  const props = { provider: withSetupApi(provider, api), projectId: 'p', onOpenChange: vi.fn(), existingNames: ['Fixture Chat notifications', ' fixture chat notifications 2 '] }
  const view = render(<ChatWizard {...props} open />)
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Fixture Chat notifications 3')
  fireEvent.change(screen.getByLabelText('Notification name'), { target: { value: 'Edited' } })
  view.rerender(<ChatWizard {...props} open={false} />)
  view.rerender(<ChatWizard {...props} open />)
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Fixture Chat notifications 3')
})
it.each(['invalid_token', 'slack_invalid_token', 'SLACK-invalid_token', 'slack invalid_token'])('uses exact descriptor guidance for %s', async code => {
  api.begin.mockRejectedValue(new Error(code))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(provider.bot.setupErrorMessages.invalid_token))
})
it.each(['group_ineligible', 'bot owned elsewhere'])('uses provider guidance for other setup failures: %s', async code => {
  api.begin.mockRejectedValue(new Error(code))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(code === 'group_ineligible' ? provider.bot.setupErrorMessages.group_ineligible : provider.bot.setupErrorMessages.bot_conflict))
})
it('uses provider guidance for polling failures', async () => {
  api.status.mockRejectedValue(new Error('invalid_token'))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(provider.bot.setupErrorMessages.invalid_token))
})
it('uses provider guidance for activation failures', async () => {
  api.activate.mockRejectedValue(new Error('invalid_token'))
  open(); start()
  await waitFor(() => expect(screen.getByText(/Connected as Person/)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(provider.bot.setupErrorMessages.invalid_token))
})
it.each(['hosted', 'unknown_reason'])('uses provider availability guidance for %s', async reason => {
  render(<ChatWizard provider={withSetupApi(provider, api)} projectId="p" open onOpenChange={vi.fn()} taskControlUnavailable={reason} />)
  start()
  await waitFor(() => expect(screen.getByText(reason === 'hosted' ? provider.bot.unavailableMessages.hosted : provider.bot.unavailableMessages.unavailable)).toBeTruthy())
})
it('recognizes provider-prefixed expired setup errors', async () => {
  api.status.mockRejectedValue(new Error('slack_pairing_expired'))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This setup link expired. Start again.'))
  expect(screen.getByLabelText('Fixture credential')).toBeTruthy()
})
it('does not echo unknown server details or fall back to Telegram guidance', async () => {
  api.begin.mockRejectedValue(new Error('invalid_token fixture-secret'))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not start Fixture Chat setup.'))
})
it('preserves Telegram default naming and exact credential guidance', async () => {
  api.begin.mockRejectedValue(new Error('telegram_invalid_token'))
  render(<ChatWizard provider={withSetupApi(telegramDescriptor, api)} projectId="p" open onOpenChange={vi.fn()} existingNames={['Telegram notifications']} />)
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Telegram notifications 2')
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: `123456789:${'A'.repeat(35)}` } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Telegram rejected this bot token. Copy it again from @BotFather and try again.'))
})

it.each(['__proto__', 'constructor', 'toString', 'slack___proto__'])('uses the wizard fallback for inherited message key %s', async code => {
  api.begin.mockRejectedValue(new Error(code))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not start Fixture Chat setup.'))
})

it('carries conversation intent into private approval and verifies both directions', async () => {
  api.activate.mockResolvedValue({ receiverId: 'receiver', inboundRevision: 'next' })
  render(<ChatWizard provider={withSetupApi(provider, api)} projectId="p" open onOpenChange={vi.fn()} intent="conversation" />)
  start()
  const checkbox = await screen.findByRole('checkbox', { name: 'Enable task control for this private chat' })
  expect(checkbox).toHaveProperty('checked', true)
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications and task control' }))
  expect(await screen.findByText(/Sending: verified by a test notification/)).toBeTruthy()
  expect(api.activate).toHaveBeenCalledWith('p', 'setup', expect.objectContaining({ taskControl: true, permissions: ['respond'] }))
})
it('finishes a notification-only bot connection without another task-control decision', async () => {
  api.activate.mockResolvedValue({ receiverId: 'receiver', inboundRevision: 'next' })
  render(<ChatWizard provider={withSetupApi(provider, api)} projectId="p" open onOpenChange={vi.fn()} intent="notifications" />)
  start()
  await screen.findByText(/Connected as Person/)
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  expect(await screen.findByRole('button', { name: 'Done' })).toBeTruthy()
  expect(api.activate).toHaveBeenCalledWith('p', 'setup', expect.objectContaining({ taskControl: false }))
})

it('reveals automatic-renewal fields only for rotating Slack tokens and omits hidden credentials', async () => {
 const { createSlackDescriptor } = await import('@/lib/chat-providers/slack')
 const slack = createSlackDescriptor({ api: {} as never, setupApi: api, subscribe: () => () => undefined })
 render(<ChatWizard provider={withSetupApi(slack, api)} projectId="p" open onOpenChange={vi.fn()} />)
 expect(screen.queryByLabelText('Client ID')).toBeNull()
 fireEvent.change(screen.getByLabelText('App-level token'), { target: { value: '  xoxe.xapp-original-token  ' } })
 fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: 'xoxb-original-token' } })
 expect(screen.getByLabelText('App refresh token')).toBeTruthy()
 expect(screen.queryByLabelText('Bot refresh token')).toBeNull()
 fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
 expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
 fireEvent.change(screen.getByLabelText('App refresh token'), { target: { value: 'xoxe-original-refresh' } })
 fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: '123.456' } })
 fireEvent.change(screen.getByLabelText('Client Secret'), { target: { value: 'a'.repeat(32) } })
 expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
 fireEvent.change(screen.getByLabelText('App-level token'), { target: { value: 'xapp-original-token' } })
 expect(screen.queryByLabelText('Client ID')).toBeNull()
 expect(screen.queryByLabelText('App refresh token')).toBeNull()
 fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
 await waitFor(() => expect(api.begin).toHaveBeenCalled())
 expect(JSON.parse(api.begin.mock.calls[0]![1].token)).toEqual({ appToken: 'xapp-original-token', botToken: 'xoxb-original-token' })
})

it('submits both rotating Slack token pairs with shared renewal credentials', async () => {
 const { createSlackDescriptor } = await import('@/lib/chat-providers/slack')
 const slack = createSlackDescriptor({ api: {} as never, setupApi: api, subscribe: () => () => undefined })
 render(<ChatWizard provider={withSetupApi(slack, api)} projectId="p" open onOpenChange={vi.fn()} />)
 for (const [label, value] of [['App-level token', 'xoxe.xapp-original-token'], ['Bot token', 'xoxe.xoxb-original-token'], ['App refresh token', 'xoxe-original-app-refresh'], ['Bot refresh token', 'xoxe-original-bot-refresh'], ['Client ID', '123.456'], ['Client Secret', 'a'.repeat(32)]]) {
  fireEvent.change(screen.getByLabelText(label!), { target: { value } })
 }
 fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
 fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
 await waitFor(() => expect(api.begin).toHaveBeenCalled())
 expect(JSON.parse(api.begin.mock.calls[0]![1].token)).toMatchObject({ appRefreshToken: 'xoxe-original-app-refresh', botRefreshToken: 'xoxe-original-bot-refresh', clientId: '123.456', clientSecret: 'a'.repeat(32) })
})
it('names the provider, not Slack, when repairing credentials', () => {
  render(<ChatWizard provider={withSetupApi(provider, api)} projectId="p" open repairing onOpenChange={vi.fn()} />)
  const description = screen.getByText(/fresh credentials from the same/)
  expect(description.textContent).toContain('Fixture Chat bot')
  expect(description.textContent).not.toContain('Slack')
})


it('shows both pasteable discovery commands when links cannot transmit the setup code', async () => {
 const manual = { ...mentionProvider, bot: { ...mentionProvider.bot,
  groupLink: () => undefined,
  discoveryCommand: (_link: string, group = false) => group ? '<@BOT> /start PAIR-CODE' : '/start PAIR-CODE',
 } }
 // The commands are instructions, so they show while the wizard still waits for the setup message.
 api.status.mockResolvedValue({ status: 'waiting', inboundRevision: 'revision' })
 render(<ChatWizard provider={withSetupApi(manual, api)} projectId="p" open onOpenChange={vi.fn()} />)
 start()
 expect(await screen.findByLabelText('Command for private chat')).toHaveProperty('value', '/start PAIR-CODE')
 expect(screen.getByLabelText('Command for group or channel')).toHaveProperty('value', '<@BOT> /start PAIR-CODE')
 expect(api.activate).not.toHaveBeenCalled()
})

it('starts an upgrade with the existing receiver and its server revision', async () => {
 render(<ChatWizard provider={withSetupApi(mentionProvider, api)} projectId="p" open onOpenChange={vi.fn()}
  upgradeReceiver={{ id: 'existing', name: 'Existing notifications', expectedRevision: 'server-revision' }} />)
 expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Existing notifications')
 start()
 await screen.findByText(/Connected as Person/)
 expect(api.begin).toHaveBeenCalledWith('p', expect.objectContaining({
  receiverId: 'existing', expectedRevision: 'server-revision', name: 'Existing notifications', dedicatedBot: true,
 }))
 expect(api.activate).not.toHaveBeenCalled()
})

it('two credential fields serialize through provider with consent and preserve cost note', async()=>{
 const multi={...mentionProvider,bot:{...mentionProvider.bot,fields:[{name:'app',label:'App credential',placeholder:'app-',pattern:/^app-/,invalid:'Invalid app'}, {name:'bot',label:'Bot credential',placeholder:'bot-',pattern:/^bot-/,invalid:'Invalid bot'}],begin:vi.fn((c:any,name:string)=>({token:JSON.stringify(c),name,dedicatedBot:true as const}))}}
 render(<ChatWizard provider={withSetupApi(multi, api)} projectId="p" open onOpenChange={vi.fn()}/>);
 fireEvent.change(screen.getByLabelText('App credential'),{target:{value:'app-secret'}});fireEvent.change(screen.getByLabelText('Bot credential'),{target:{value:'bot-secret'}});
 expect(api.begin).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'Continue'})).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('checkbox',{name:/bot is dedicated/}));fireEvent.click(screen.getByRole('button',{name:'Continue'}));
 await screen.findByText(/Connected as Person/);expect(multi.bot.begin).toHaveBeenCalledWith({app:'app-secret',bot:'bot-secret'},'Fixture Chat notifications');
 fireEvent.click(screen.getByRole('checkbox',{name:/Enable task control for this private chat/}));
 expect(screen.getByText('Answering, starting and continuing tasks runs the agent and may incur provider costs.')).toBeTruthy();expect(document.body.textContent).not.toContain('app-secret');
})
it('provider with mention discovery never instructs a Telegram Start for private approval',async()=>{
 const mention={...mentionProvider,bot:{...mentionProvider.bot,discoveryHint:'Mention Fixture to discover.',privateHint:'Mention Fixture privately.',groupHint:'Mention Fixture in a channel.'}};
 api.status.mockResolvedValue({ status: 'waiting', inboundRevision: 'revision' })
 render(<ChatWizard provider={withSetupApi(mention, api)} projectId="p" open onOpenChange={vi.fn()}/>);start();
 expect(await screen.findByText('Mention Fixture privately.')).toBeTruthy();expect(document.body.textContent).not.toContain('first person who presses Start');
})
it('mention-based group approval keeps visibility consent, comparison and permissions', async () => {
 api.status.mockResolvedValue({ status: 'candidate', inboundRevision: 'revision', candidate: { userId: 'person', label: 'Person', chatType: 'group', chatId: 'CHANNEL-A' } })
 api.activate.mockResolvedValue({ receiverId: 'receiver', inboundRevision: 'active-revision' })
 open(mentionProvider); start()
 await screen.findByText(mentionProvider.bot.approval.groupControl)
 expect(screen.getByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
 fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
 fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
 fireEvent.click(await screen.findByRole('checkbox', { name: /Enable optional task control/ }))
 api.status.mockResolvedValue({ status: 'candidate', inboundRevision: 'revision2', candidate: { userId: 'person', label: 'Person', chatType: 'private', comparisonCode: 'COMPARE' } })
 fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
 await screen.findByText(mentionProvider.bot.approval.controlHint)
 await screen.findByText(mentionProvider.bot.approval.comparisonHint)
 expect(document.body.textContent).not.toContain('private Start')
 expect(screen.queryByRole('checkbox', { name: 'Start tasks' })).toBeNull()
 expect(screen.getByRole('button', { name: 'Activate task control' })).toHaveProperty('disabled', true)
 expect(screen.getByText('Answering, starting and continuing tasks runs the agent and may incur provider costs.')).toBeTruthy()
 fireEvent.click(screen.getByRole('checkbox', { name: /I compared the code/ }))
 expect(screen.getByRole('button', { name: 'Activate task control' })).toHaveProperty('disabled', false)
})
