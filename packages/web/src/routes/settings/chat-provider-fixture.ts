import { telegramDescriptor } from '@/lib/chat-providers/telegram'
import type { ChatProviderDescriptor, ChatSetupApi } from '@/lib/chat-providers/types'

/** The same descriptor with its setup calls routed to a test double. */
export const withSetupApi = <T extends ChatProviderDescriptor>(provider: T, setupApi: ChatSetupApi): T => ({ ...provider, bot: { ...provider.bot, setupApi } })

/** Synthetic mention-based provider; no platform calls or transport. */
const mentionApproval = {
  savedCredentials: 'Checks the saved app and bot credentials. Credentials are never displayed.',
  checkingCredentials: 'Checking saved credentials…',
  waitingTitle: 'Mention Fixture to approve yourself.',
  waiting: (username: string, group: boolean) => `Mention ${username} privately${group ? ' as a channel member' : ''}.`,
  candidate: (username: string) => `mentioned ${username}.`,
  controlDescription: 'Mention Fixture privately to approve task control.',
  privateControl: 'The first person who mentions Fixture is approved to control tasks.',
  groupControl: 'Mention Fixture privately and compare the code after notifications are active.',
  controlHint: 'Mention Fixture privately to approve the person who may control tasks.',
  comparisonHint: 'Compare the code from the private mention.',
}
export const fixtureProvider = {
  ...telegramDescriptor, id: 'slack' as const, name: 'Fixture Chat', format: 'slack.v1' as const,
  bot: { ...telegramDescriptor.bot, approval: mentionApproval, groupRestriction: 'Only joined channels are supported.', credentialHelp: { add: 'Enter both credentials for the connected app.', storage: 'Both credentials are saved only in this project’s secret store.' }, settingsErrorMessages: { invalid_token: 'Renew Fixture credential.' } },
}
