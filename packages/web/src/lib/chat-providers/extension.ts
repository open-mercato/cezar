import { subscribeTopic } from '@/api/ws'
import { MessagesSquareIcon } from 'lucide-react'
import type { ExtensionChatProvider } from '@open-mercato/cezar-api-client'
import { createExtensionChatApi } from '@/api/client'
import type { ChatProviderDescriptor } from './types'
import { chatSettingsErrorMessages, chatSetupErrorMessages, chatUnavailableMessages } from './messages'

// These clients only capture provider IDs, never project state or credentials. Keep their
// identity across extension-list refreshes: setup consumers own sessions by API identity.
const clients = new Map<string, ReturnType<typeof createExtensionChatApi>>()

/** Uses the existing chat setup/approval components with an extension-owned typed API. */
export function extensionChatDescriptor(extensionId: string, declaration: ExtensionChatProvider): ChatProviderDescriptor {
  const key = `${extensionId}/${declaration.id}`
  let api = clients.get(key)
  if (!api) { api = createExtensionChatApi(extensionId, declaration.id); clients.set(key, api) }
  const prefix = declaration.commandPrefix
  const name = declaration.label
  const providerErrors = {
    invalid_token: `${name} rejected these credentials. Check them in your provider’s settings and try again.`,
    pairing_required: `Send the current setup command to the bot in ${name} before continuing.`,
    group_ineligible: `The bot must be able to access this group and verify its members. Check its permissions in ${name}.`,
    chat_conflict: 'This chat is already connected to this bot. Manage it in Integrations instead.',
  }
  return {
    id: `${extensionId}/${declaration.id}`, name, format: `${extensionId}/${declaration.id}.v1`, icon: MessagesSquareIcon,
    description: `Send project updates and control tasks through ${name}.`,
    bot: {
      api, setupApi: api.setup,
      commands: {
        respond: `${prefix}tasks, ${prefix}status and ${prefix}reply`, reply: `${prefix}reply`,
        cancel: `${prefix}cancel`, continue: `${prefix}continue`,
        guidance: `Send commands to the bot using the ${JSON.stringify(prefix)} prefix. In groups, address the bot as required by ${name}.`,
      },
      // Setup status uses the existing bounded setup query. Snapshot views refresh on focus.
      subscribe: changed => subscribeTopic('extensions-inbound', () => changed()),
      validChatId: value => /^[A-Za-z0-9_.:@-]{1,128}$/.test(value ?? ''),
      isGroup: value => value?.startsWith(declaration.groupPrefix) === true,
      fields: declaration.credentials.map(field => ({ name: field.name, label: field.label, placeholder: field.label, pattern: /.+/, invalid: `Enter ${field.label}.`, optional: field.optional === true, secret: field.secret !== false })),
      setupErrorMessages: { ...chatSetupErrorMessages(name), ...providerErrors },
      settingsErrorMessages: { ...chatSettingsErrorMessages(name), ...providerErrors },
      unavailableMessages: chatUnavailableMessages(name),
      credentialHelp: { add: 'Use this provider’s credentials.', storage: 'Credentials are encrypted for this project.' },
      credentialHint: `Continue verifies credentials with ${name}.`,
      help: { label: name, href: declaration.discoveryUrl },
      lastContactLabel: 'Last connected',
      groupRestriction: 'The provider must verify group membership.',
      approval: {
        savedCredentials: 'Verify saved credentials and create a one-time setup link.', checkingCredentials: 'Checking credentials…',
        waitingTitle: `Open ${name} and connect`, waiting: () => 'Open the private setup link and send the start command.',
        candidate: username => `connected as ${username}.`,
        controlDescription: 'Approve the person who may control project tasks.', privateControl: 'Approve this person to control tasks.',
        groupControl: 'Compare the private verification code before granting group access.', controlHint: 'Open the private setup link.',
        comparisonHint: 'Compare the code in your private chat.',
      },
      discoveryHint: 'Choose a private or group destination.', privateHint: 'Open the link and send the start command.',
      groupHint: 'Open the link in the destination group.', groupLink: link => link,
      discoveryCommand: link => `${declaration.commandPrefix}start ${new URL(link).searchParams.get('cezar_start') ?? ''}`,
      // An optional field left empty is omitted, not sent as an empty credential.
      begin: (credentials, name) => ({ token: JSON.stringify(Object.fromEntries(Object.entries(credentials).filter(([, value]) => value !== ''))), name, dedicatedBot: true }),
    },
  }
}
