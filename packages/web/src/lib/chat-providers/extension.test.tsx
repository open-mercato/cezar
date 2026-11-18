import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatSetupBegun, ExtensionChatProvider } from '@open-mercato/cezar-api-client'
import { extensionChatDescriptor } from './extension'
import { ChatWizard } from '@/routes/settings/chat-wizard'
import { ChatSetupHelp } from '@/routes/settings/chat-setup-help'

const declaration: ExtensionChatProvider = {
  id: 'chat', label: 'Mattermost', receiveModel: 'ordered', credentials: [{ name: 'token', label: 'Access token', secret: true }],
  limits: { maxText: 4000, buttonsPerMessage: 0, perChatPerSecond: 1, perBotPerSecond: 5 },
  commandPrefix: 'cezar ', groupPrefix: 'group:', discoveryUrl: 'https://docs.mattermost.com',
}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it.each(['cezar ', '!'])('derives task-control instructions from prefix %s', prefix => {
  const provider = extensionChatDescriptor('test.commands', { ...declaration, commandPrefix: prefix })
  expect(provider.bot?.commands).toMatchObject({ reply: `${prefix}reply`, cancel: `${prefix}cancel`, continue: `${prefix}continue` })
  expect(provider.bot?.commands.respond).toBe(`${prefix}tasks, ${prefix}status and ${prefix}reply`)
  expect(provider.bot?.commands.guidance).not.toBe('')
  expect(provider.bot?.discoveryCommand?.('https://example.org/?cezar_start=code')).toBe(`${prefix}start code`)
})
it.each([false, true])('provides generic external setup help (connecting=%s)', connecting => {
  render(<ChatSetupHelp providerId="test.help/chat" connecting={connecting} />)
  expect(document.body.textContent).not.toMatch(/Discord|Slack|Telegram|Clyde|Message Content Intent/)
  expect(document.body.textContent).toMatch(connecting ? /current.*command|command.*current/i : /credentials/i)
})
it.each(['waiting', 'pending begin'])('keeps pairing across a descriptor refresh while %s', async phase => {
  const provider = extensionChatDescriptor(`test.${phase}`, declaration)
  const api = provider.bot!.setupApi
  let finish!: (value: ChatSetupBegun) => void
  const response = { setupId: 'pairing', receiverId: 'receiver', bot: { id: 'bot', username: 'bot' }, expiresAt: Date.now() + 60_000, deepLink: 'https://example.org/?cezar_start=code' }
  vi.spyOn(api, 'begin').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  vi.spyOn(api, 'status').mockResolvedValue({ status: 'waiting', receiverId: 'receiver', bot: { id: 'bot', username: 'bot' }, inboundRevision: 'revision' })
  const cancel = vi.spyOn(api, 'cancel').mockResolvedValue(undefined)
  const props = { projectId: 'p', open: true, onOpenChange: vi.fn() }
  const view = render(<ChatWizard {...props} provider={provider as typeof provider & { bot: NonNullable<typeof provider.bot> }} />)
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  if (phase === 'waiting') { finish(response); await screen.findByLabelText('Setup command') }
  const refreshed = extensionChatDescriptor(`test.${phase}`, { ...declaration, credentials: [...declaration.credentials] })
  view.rerender(<ChatWizard {...props} provider={refreshed as typeof refreshed & { bot: NonNullable<typeof refreshed.bot> }} />)
  if (phase === 'pending begin') finish(response)
  await waitFor(() => expect(screen.getByLabelText('Setup command')).toHaveProperty('value', 'cezar start code'))
  expect(cancel).not.toHaveBeenCalled()
  view.unmount()
  expect(cancel).toHaveBeenCalledWith('p', 'pairing')
})
it('names the extension provider and never Telegram in its error copy', () => {
  const { setupErrorMessages, settingsErrorMessages } = extensionChatDescriptor('test.copy', declaration).bot
  for (const message of [...Object.values(setupErrorMessages), ...Object.values(settingsErrorMessages)]) expect(message).not.toMatch(/Telegram|BotFather/)
  expect(setupErrorMessages.blocked).toBe('Mattermost blocked this bot. Unblock or recreate it, then try again.')
})
it('keeps failed external credential guidance specific to that provider', async () => {
  const provider = extensionChatDescriptor('test.failure', declaration)
  vi.spyOn(provider.bot!.setupApi, 'begin').mockRejectedValue(new Error('invalid_token'))
  render(<ChatWizard projectId="p" open onOpenChange={vi.fn()} provider={provider as typeof provider & { bot: NonNullable<typeof provider.bot> }} />)
  expect(screen.getByRole('link', { name: 'Mattermost setup documentation' }).getAttribute('href')).toBe('https://docs.mattermost.com')
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'bad' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  const error = await screen.findByRole('alert')
  expect(error.textContent).toMatch(/Mattermost/)
  expect(error.textContent).not.toMatch(/BotFather|Telegram|Discord/)
  expect(screen.getByLabelText('Access token')).toHaveProperty('value', 'bad')
})
it('honours optional and non-secret credential flags from the extension SDK', async () => {
  const provider = extensionChatDescriptor('test.flags', { ...declaration, credentials: [
    { name: 'token', label: 'Access token', secret: true },
    { name: 'workspaceUrl', label: 'Workspace URL', secret: false, optional: true },
  ] })
  const begin = vi.spyOn(provider.bot!.setupApi, 'begin').mockRejectedValue(new Error('invalid_token'))
  render(<ChatWizard projectId="p" open onOpenChange={vi.fn()} provider={provider as typeof provider & { bot: NonNullable<typeof provider.bot> }} />)
  expect(screen.getByLabelText('Access token').getAttribute('type')).toBe('password')
  expect(screen.getByLabelText('Workspace URL (optional)').getAttribute('type')).toBe('text')
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  const next = screen.getByRole('button', { name: 'Continue' })
  expect(next).toHaveProperty('disabled', false)
  fireEvent.click(next)
  await waitFor(() => expect(begin).toHaveBeenCalled())
  expect(JSON.parse(begin.mock.calls[0]![1].token!)).toEqual({ token: 'secret' })
})
