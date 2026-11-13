import { MessagesSquareIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
import { chatSettingsErrorMessages, chatSetupErrorMessages, chatUnavailableMessages } from '../messages'
type Bot = ChatProviderDescriptor['bot']
const discordDescriptor: Omit<ChatProviderDescriptor, 'bot'> = { id: 'discord', name: 'Discord', format: 'discord.v1', webhookNotifications: { instructions: 'In Discord, open the channel’s settings → Integrations → Webhooks → New Webhook → Copy Webhook URL, then paste it below.' }, icon: MessagesSquareIcon, description: 'Send task updates to your Discord channels.' }
export function discordDiscoveryCommand(link: string, group = false): string | undefined {
 try { const url = new URL(link), bot = url.pathname === '/oauth2/authorize' ? url.searchParams.get('client_id') : url.pathname.split('/').at(-1), code = new URLSearchParams(url.hash.slice(1)).get('cezar-start');
  if (url.origin !== 'https://discord.com' || !bot || !/^[1-9][0-9]{0,19}$/.test(bot) || !code || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) return;
  return `${group ? `<@${bot}> ` : ''}/start ${code}`;
 } catch { return undefined }
}
/** The root supplies its typed route facade once Discord routes have been registered. */
export function createDiscordDescriptor(ports: Pick<Bot, 'api' | 'setupApi' | 'subscribe'>): ChatProviderDescriptor {
 const unavailableMessages = chatUnavailableMessages('Discord')
 return { ...discordDescriptor, bot: {
  discoveryCommand: discordDiscoveryCommand,
  ...ports, unavailableMessages,
  validChatId: id => /^discord:(?:dm:[1-9][0-9]{0,19}|guild:[1-9][0-9]{0,19}:[1-9][0-9]{0,19})$/.test(id ?? ''), isGroup: id => id?.startsWith('discord:guild:') === true,
  fields: [{ name: 'token', label: 'Bot token', placeholder: 'Bot token from the developer portal', pattern: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/, invalid: 'Copy the bot token from Discord Developer Portal → Bot.' }],
  setupErrorMessages: { ...chatSetupErrorMessages('Discord'), invalid_token: 'Discord rejected this bot token.', blocked: 'Check Message Content intent, bot permissions, and that Interactions Endpoint URL is empty.', group_ineligible: 'Choose a guild text channel. Threads and group DMs are not supported.', candidate_not_group_member: 'This person must be able to view the channel.', comparison_required: 'Compare the private code before approving.', pairing_expired: 'The setup code expired. Start again.',
   bot_conflict: 'This Discord bot is connected to another project or cezar. Use a different bot, or disconnect it there first.', pairing_limit: 'Too many Discord setups are open. Finish or cancel one, or wait five minutes, then try again.',
   chat_limit: 'This Discord bot already serves 20 chats. Remove a chat before adding another.', receiver_changed: 'This Discord receiver changed. Refresh it and try again.', receiver_missing: 'This Discord receiver no longer exists. Refresh the page.' },
  settingsErrorMessages: { ...chatSettingsErrorMessages('Discord'), credentials_unavailable: 'Reconnect using the current bot token.', owner_conflict: 'Another cockpit owns this bot.', revision_conflict: 'Refresh the settings and try again.' },
  credentialHelp: { add: 'Paste the token for the bot connected to this project.', storage: 'Saved only in this project’s encrypted secret store.' },
  credentialHint: 'Continue checks the token with Discord and starts setup. Nothing is sent to your chats until you activate notifications.',
  help: { label: 'Discord Developer Portal', href: 'https://discord.com/developers/applications' },
  commands: { respond: '/tasks, /status and /reply', reply: '/reply', cancel: '/cancel', continue: '/continue', guidance: 'In a direct message, send the command as a text message to the bot. In a guild text channel, select the bot from Discord’s @ picker, then type the command after the mention and send it as a text message.' },
  groupRestriction: 'Guild text channels only; threads and group DMs are not supported.',
  discoveryHint: 'Invite the bot to your server, then send the setup command from the chat that should get notifications.',
  groupFirst: true, groupLabel: 'Invite the bot to your server', privateLabel: 'Open a private chat with the bot',
  groupHint: 'The invitation already includes the permissions Cezar needs. For a channel, paste the channel command in a text channel the bot can see.',
  privateHint: 'Open the bot from that server’s member list → Message, then paste the private command. If Discord refuses the message, allow direct messages in that server’s privacy settings.',
  groupLink: link => { try { const source = new URL(link); const id = source.pathname.split('/').at(-1); if (!id || !/^[1-9][0-9]{0,19}$/.test(id)) return; return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=68608${source.hash}`; } catch { return undefined } },
  approval: { savedCredentials: 'Cezar checks the saved bot token and creates a five-minute setup code.', checkingCredentials: 'Checking the saved bot token…', waitingTitle: 'Send the setup command in Discord', waiting: (_id, group) => group ? 'The trusted person sends the command in a private message to the bot.' : 'Send the setup command in a private message to the bot.', candidate: () => 'sent the setup command.', controlDescription: 'Approve a trusted person through a private setup command.', privateControl: 'The person who sends the setup command is approved.', groupControl: 'Task control requires a second private setup command and code comparison.', controlHint: 'Send the private setup command, then compare the code.', comparisonHint: 'Compare the private code before approving.' },
  begin: (credentials, name) => ({ token: credentials.token!, name, dedicatedBot: true }),
 } };
}
