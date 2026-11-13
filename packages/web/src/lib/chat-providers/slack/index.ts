import { slackAppTokenPattern, slackBotTokenPattern, slackRefreshTokenPattern, slackCredentialRecordSchema } from '@open-mercato/cezar-api-client'
import { HashIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
import { chatSettingsErrorMessages, chatSetupErrorMessages, chatUnavailableMessages } from '../messages'
const rotating = (values: Readonly<Record<string, string>>) => [values.appToken, values.botToken].some(value => value?.trim().startsWith('xoxe.'))
type Bot = ChatProviderDescriptor['bot']
/** Root supplies the typed route facade after mounting Slack's shared route family. */
export function createSlackDescriptor(bindings: Pick<Bot, 'api' | 'setupApi' | 'subscribe'>): ChatProviderDescriptor {
 return { ...slackDescriptor, description: 'Send updates and answer tasks from Slack.', bot: {
  ...bindings,
  // Copy only text; Slack's composer picker must supply the native bot mention.
  discoveryCommand: link => slackDiscoveryCommand(link),
  fields: [
   { name: 'appToken', label: 'App-level token', placeholder: 'xapp-… or xoxe.xapp-…', pattern: slackAppTokenPattern, invalid: 'Paste the app-level token with connections:write.' },
   { name: 'botToken', label: 'Bot token', placeholder: 'xoxb-… or xoxe.xoxb-…', pattern: slackBotTokenPattern, invalid: 'Paste the installed app’s bot token.' },
   { name: 'appRefreshToken', label: 'App refresh token', placeholder: 'xoxe-…', pattern: slackRefreshTokenPattern, invalid: 'Copy the Refresh token shown with your app access token.', visibleWhen: values => values.appToken?.trim().startsWith('xoxe.') === true, hint: 'Your app token expires. Copy Refresh token from the same Slack window; Cezar will renew access automatically.' },
   { name: 'botRefreshToken', label: 'Bot refresh token', placeholder: 'xoxe-…', pattern: slackRefreshTokenPattern, invalid: 'Copy the Refresh token shown with your bot access token.', visibleWhen: values => values.botToken?.trim().startsWith('xoxe.') === true, hint: 'Copy the refresh token paired with your bot access token. Cezar will renew it automatically.' },
   { name: 'clientId', label: 'Client ID', placeholder: '123456.789012', pattern: /^\d{1,60}\.\d{1,60}$/, invalid: 'Copy Client ID from Basic Information → App Credentials.', visibleWhen: rotating, hint: 'In Slack app settings, open Basic Information → App Credentials → Client ID.' },
   { name: 'clientSecret', label: 'Client Secret', placeholder: 'Client Secret', pattern: /^[A-Za-z0-9]{16,256}$/, invalid: 'Copy Client Secret from Basic Information → App Credentials.', visibleWhen: rotating, hint: 'On the same page, reveal and copy Client Secret. These credentials let Cezar renew access without asking you again.' },
  ],
  validChatId: id => /^(private|group):T[A-Z0-9]+:U[A-Z0-9]+:[CDG][A-Z0-9]+$/.test(id ?? ''),
  isGroup: id => id?.startsWith('group:') === true,
  begin: (credentials, name) => ({ token: JSON.stringify(slackCredentialRecordSchema.parse({
   appToken: credentials.appToken, botToken: credentials.botToken,
   ...(credentials.appToken?.startsWith('xoxe.') ? { appRefreshToken: credentials.appRefreshToken } : {}),
   ...(credentials.botToken?.startsWith('xoxe.') ? { botRefreshToken: credentials.botRefreshToken } : {}),
   ...(rotating(credentials) ? { clientId: credentials.clientId, clientSecret: credentials.clientSecret } : {}),
  })), name, dedicatedBot: true }),
  credentialRepair: 'Reconnect with fresh access and refresh tokens from the same app.',
  credentialHelp: { add: 'Use both tokens from the same installed Slack app.', storage: 'Credentials are saved only in this project’s secret store.' },
  credentialHint: 'Continue checks both tokens with Slack and starts setup. Nothing is sent to your chats until you activate notifications.',
  help: { label: 'Slack app settings', href: 'https://api.slack.com/apps' },
  commands: { respond: 'cezar tasks, cezar status and cezar reply', reply: 'cezar reply', cancel: 'cezar cancel', continue: 'cezar continue', guidance: 'Use /cezar tasks or /cezar status from Slack’s command menu to check tasks. For replies and other actions, use the text commands below. In a direct message, send the command to the bot. In channels and group DMs, select the installed bot from Slack’s @ picker, then type the command after the mention.' },
  groupRestriction: 'Invite the bot to the channel. All channel and group-DM members can see project messages.',
  discoveryHint: 'Send the setup command from the chat that should get notifications: your direct message with the app, or a channel. In a channel, select the installed bot from Slack’s @ picker, then paste the command after the mention.',
  privateLabel: 'Open the app in Slack', groupLabel: 'Use a channel instead',
  privateHint: 'Open the app’s Messages tab and paste the command. If Messages is missing, enable the writable Messages tab in App Home in Slack app settings.',
  groupHint: 'Invite the bot to the channel, select it from Slack’s @ picker, then paste the same command after the mention and send.',
  groupLink: () => undefined,
  approval: {
   savedCredentials: 'Cezar checks the saved Slack tokens and creates a setup code valid for five minutes.', checkingCredentials: 'Checking Slack credentials…', waitingTitle: 'Send the setup command in Slack',
   waiting: (_username, group) => group ? 'The person to approve sends the displayed cezar start command in their own DM with the bot.' : 'Send the displayed cezar start command in your DM with the bot.',
   candidate: () => 'sent the setup command in Slack.', controlDescription: 'The trusted person sends the private setup command to request task control.',
   privateControl: 'Approve the person who sent the setup command.', groupControl: 'Task control requires a second private setup command and code comparison.', controlHint: 'Send the private setup command to request approval.', comparisonHint: 'Compare the code received privately in Slack.',
  },
  unavailableMessages: chatUnavailableMessages('Slack'),
  setupErrorMessages: { ...chatSetupErrorMessages('Slack'), invalid_token: 'Slack rejected the credentials. Check the tokens belong to the same installed app. For automatic renewal, also check Client ID, Client Secret and the matching refresh tokens.', blocked: 'Check the app’s scopes, Socket Mode and channel membership.', comparison_required: 'Compare the code received in your private Slack conversation.', group_visibility_required: 'Confirm that group members may see project messages.',
   bot_conflict: 'This Slack app is connected to another project or cezar. Use a different app, or disconnect it there first.', pairing_limit: 'Too many Slack setups are open. Finish or cancel one, or wait five minutes, then try again.',
   chat_limit: 'This Slack app already serves 20 chats. Remove a chat before adding another.', receiver_changed: 'This Slack receiver changed. Refresh it and try again.', receiver_missing: 'This Slack receiver no longer exists. Refresh the page.' },
  settingsErrorMessages: { ...chatSettingsErrorMessages('Slack'), credentials_unavailable: 'Slack access could not be renewed or the saved tokens are unavailable. Reconnect with fresh tokens and their matching refresh tokens.', owner_conflict: 'Another cockpit owns this Slack bot.', revision_conflict: 'Settings changed. Refresh and try again.' },
 } }
}
export const slackDiscoveryCommand = (link: string): string => `cezar start ${new URL(link).searchParams.get('cezar_start') ?? ''}`
const slackDescriptor: Omit<ChatProviderDescriptor, 'bot'> = { id: 'slack', name: 'Slack', format: 'slack.v1', webhookNotifications: { instructions: 'In Slack, create an app with an Incoming Webhook for the channel, install it and paste the Webhook URL below.' }, icon: HashIcon, description: 'Send task updates to your Slack channels.' }
