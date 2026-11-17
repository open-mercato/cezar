import { expect, it } from 'vitest'
import { telegramDescriptor } from './telegram'
import { chatErrorMessage } from './messages'
const providers = [telegramDescriptor]
const sharedSetupCodes = ['bot_conflict', 'pairing_limit', 'chat_limit']
const upgradeCodes = ['receiver_changed', 'receiver_missing']

it.each(providers.map(provider => [provider.name, provider] as const))('gives %s its own copy for every shared setup failure', (_name, provider) => {
  const codes = provider.id === 'telegram' ? sharedSetupCodes : [...sharedSetupCodes, ...upgradeCodes]
  for (const code of codes) {
    expect(provider.bot!.setupErrorMessages[code], code).toBeTruthy()
  }
  // A settings action (Approve another member) can hit the limit too.
  expect(chatErrorMessage(provider, new Error(`${provider.id}_chat_limit`))).toBe(provider.bot!.setupErrorMessages.chat_limit)
  expect(provider.bot!.setupErrorMessages.chat_limit).toMatch(/20 chats/)
})

it('names the task-control flag in every provider’s flag_off copy', () => {
  for (const provider of providers) expect(provider.bot!.unavailableMessages.flag_off).toContain('CEZ_CHAT_INBOUND=1')
})

const sharedCodes = ['conflict', 'already_paired', 'pairing_changed', 'bot_busy', 'grant_limit', 'damaged_state', 'vault_unavailable', 'receiver_ineligible', 'chat_changed', 'revision_required', 'binding_missing', 'pairing_expired']
it.each(providers.map(provider => [provider.name, provider] as const))('gives %s actionable copy for every shared chat failure', (_name, provider) => {
  const fallback = `${provider.name} could not complete that action. Refresh and try again.`
  for (const code of sharedCodes) expect(chatErrorMessage(provider, new Error(`${provider.id}_${code}`)), code).not.toBe(fallback)
  expect(chatErrorMessage(provider, new Error('damaged_state'))).toMatch(/Reset access/)
})

it.each(providers.map(provider => [provider.name, provider] as const))('never sends %s users to a provider tab that does not exist', (_name, provider) => {
  for (const message of [...Object.values(provider.bot!.setupErrorMessages), ...Object.values(provider.bot!.settingsErrorMessages)]) expect(message).not.toMatch(/ tab\b/)
})

it('drives Telegram setup through the one shared chat route facade', async () => {
  const { telegramApi } = await import('@/api/client')
  expect(telegramDescriptor.bot.setupApi).toBe(telegramApi.setup)
})
