import { telegramApi } from '@/api/client'
import { subscribeTopic } from '@/api/ws'
import { chatInboundInvalidationSchema } from '@open-mercato/cezar-api-client'
import { SendIcon } from 'lucide-react'
import type { ChatProviderDescriptor } from '../types'
import { chatSettingsErrorMessages, chatSetupErrorMessages, chatUnavailableMessages } from '../messages'
/** Telegram's own wording; everything provider-neutral lives in `../messages`. */
const telegramPlatformMessages = {
  chat_conflict:
    'This chat already has task control through another Telegram receiver. A private chat serves one person, so use that receiver.',
  group_ineligible: 'This group cannot receive replies. Choose a private or non-forum group chat.',
  invalid_token: 'Telegram rejected the saved bot token. Get a new token from @BotFather and use Add a chat with it.',
  pairing_required: 'Approve a person with Enable task control before enabling replies.',
}

/** Friendly copy for every setup failure the wizard's calls can surface; never the raw code. */
const wizardErrorMessages: Record<string, string> = {
  ...chatSetupErrorMessages('Telegram'),
  chat_conflict: 'This chat is already connected to this bot. Manage it on the Telegram integration page instead.',
  group_ineligible:
    'This group cannot be used. Forum groups (with topics) are not supported, and the bot must still be a member.',
  invalid_token: 'Telegram rejected this bot token. Copy it again from @BotFather and try again.',
  pairing_required: 'Press Start in Telegram before continuing.',
}

export const telegramDescriptor: ChatProviderDescriptor = {
  id: 'telegram',
  name: 'Telegram',
  format: 'telegram.v1',
  icon: SendIcon,
  description: 'Send task updates to your Telegram chats and answer tasks from them.',
  directSetup: true,
  bot: {
    api: telegramApi,
    unavailableMessages: chatUnavailableMessages('Telegram'),
    setupErrorMessages: wizardErrorMessages,
    settingsErrorMessages: { ...chatSettingsErrorMessages('Telegram'), ...telegramPlatformMessages },
    setupApi: telegramApi.setup,
    subscribe: changed =>
      subscribeTopic('telegram-inbound', data => {
        if (chatInboundInvalidationSchema.safeParse(data).success) changed()
      }),
    validChatId: id => /^-?[1-9][0-9]*$/.test(id ?? ''),
    isGroup: id => id?.startsWith('-') === true,
    fields: [
      {
        name: 'token',
        label: 'Bot token',
        placeholder: '123456789:AA…',
        pattern: /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/,
        invalid: 'This does not look like a bot token. It has the form 123456789:AA… — copy it from @BotFather.',
      },
    ],
    credentialHelp: {
      create: 'Create a bot with',
      add: 'Paste the token of the bot you already connected. Each person or group gets its own chat.',
      storage: 'The token is saved only in this project’s secret store.',
    },
    commands: {
      respond: '/tasks, /status and /reply',
      reply: '/reply',
      cancel: '/cancel',
      continue: '/continue',
      guidance: '',
    },
    lastContactLabel: 'Last successful poll',
    groupRestriction: 'Forum groups are not supported.',
    credentialHint:
      'Continue checks the token with Telegram and starts setup. Nothing is sent to your chats until you activate notifications.',
    help: { label: '@BotFather', href: 'https://t.me/BotFather' },
    approval: {
      savedCredentials:
        'Cezar checks the chat’s saved bot token and creates a one-time link that expires in five minutes. The token is never shown here.',
      checkingCredentials: 'Checking the saved bot token…',
      waitingTitle: 'Open Telegram and press Start',
      waiting: (username, group) =>
        `Waiting for Telegram… ${group ? 'The person to approve opens this link in their own private chat with' : 'Open this link in your private chat with'} @${username} and ${group ? 'presses' : 'press'} Start.`,
      candidate: username => `pressed Start in @${username}.`,
      controlDescription: 'The trusted person opens the private link and presses Start to get task control.',
      privateControl: 'The first person who presses Start is approved to control tasks. No second link is needed.',
      groupControl: 'Task control requires a second private Start and code comparison after notifications are active.',
      controlHint: 'Open the private setup link and press Start to approve the person who may control tasks.',
      comparisonHint: 'Task control requires the second private Start and code comparison.',
      privateLink: 'Open the private chat and press Start',
    },
    discoveryHint: 'Choose the chat that receives notifications: your private chat or a group.',
    privateHint: 'Opens your own chat with the bot. Press Start there.',
    groupHint:
      'Pick a group and add the bot; it starts there automatically. Forum groups (with topics) are not supported.',
    groupLink(link) {
      try {
        const url = new URL(link),
          code = url.searchParams.get('start')
        if (!code) return
        url.search = ''
        url.searchParams.set('startgroup', code)
        return url.toString()
      } catch {
        return undefined
      }
    },
    begin: (credentials, name) => ({ token: credentials.token!, name, dedicatedBot: true }),
  },
}
