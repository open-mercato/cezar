import type { ChatProviderDescriptor } from './types'

/** One off-state copy for every chat provider: which env var, and that cezar must restart. */
export function chatUnavailableMessages(name: string): Readonly<Record<'flag_off' | 'webhooks_off' | 'hosted' | 'unavailable', string>> {
  return {
    flag_off: 'Task control needs CEZ_CHAT_INBOUND=1. Restart cezar with it to turn task control on.',
    webhooks_off: `${name} needs CEZ_WEBHOOKS=1. Restart cezar with it, then reload this page.`,
    hosted: `${name} is not available on a hosted cockpit. Run cezar locally to connect a bot.`,
    unavailable: `${name} is unavailable right now. Try again in a moment.`,
  }
}

/** Setup failures any provider can surface. Providers add their own platform wording on top. */
export function chatSetupErrorMessages(name: string): Record<string, string> {
  return {
    ...chatUnavailableMessages(name),
    blocked: `${name} blocked this bot. Unblock or recreate it, then try again.`,
    conflict: `${name} settings changed. Start setup again.`,
    damaged_state: `${name} access is damaged. Reset access, then start setup again.`,
    vault_unavailable: 'The bot token store is unavailable. Restore it, then retry setup.',
    already_paired: 'This person is already approved for this chat, so no further approval is needed.',
    pairing_expired: 'This setup link expired. Start again.',
    pairing_limit: `Too many ${name} setups are open. Finish or cancel one, or wait five minutes, then try again.`,
    chat_limit: 'This bot already serves 20 chats. Remove a chat before adding another.',
    comparison_required: `Compare the code sent privately by ${name} before continuing.`,
    pairing_changed: 'The pairing changed before it was approved. Start setup again.',
    chat_changed: `The ${name} chat changed. Refresh and try again.`,
    bot_conflict: 'This bot is connected to another project or cezar. Use a different bot, or disconnect it there first.',
    bot_busy: 'This bot is busy with another change. Try again in a moment.',
    group_visibility_required: 'Confirm that every member of this group can read project messages.',
    receiver_ineligible: 'This chat is not ready. Check its diagnostics and try again.',
    receiver_creation_unavailable: `${name} setup is unavailable right now. Try again in a moment.`,
    receiver_creation_failed: `${name} could not set up this chat. Try again.`,
    binding_missing: 'This bot is no longer assigned to this chat. Refresh the page.',
    grant_limit: `This project has reached its ${name} access limit.`,
    candidate_not_group_member: 'That person is not a member of this group. Have them join and try again.',
  }
}

/** Failures of the settings panel's calls, for any provider. */
export function chatSettingsErrorMessages(name: string): Record<string, string> {
  return {
    ...chatUnavailableMessages(name),
    blocked: `${name} blocked this bot. Unblock or recreate it, then try again.`,
    conflict: `${name} settings changed. Refresh the receiver and start setup again.`,
    damaged_state: `${name} access is damaged. Reset access below, then start setup again.`,
    vault_unavailable: 'The bot token store is unavailable. Restore it, then retry setup.',
    receiver_ineligible: 'This receiver is not ready. Test and activate it with Standard content and waiting notifications enabled.',
    group_visibility_required: 'Confirm that group members may see project messages before continuing.',
    pairing_changed: `The pairing changed before it was approved. Start ${name} setup again.`,
    chat_changed: `The ${name} chat changed. Refresh the receiver and try again.`,
    revision_required: 'The settings changed. Review the refreshed settings, then try again.',
    revision_conflict: 'Settings changed. Review the refreshed settings and try again.',
    receiver_changed: 'The receiver changed. Refresh it and try again.',
    credentials_unavailable: 'The bot token is unavailable or no longer works. Use Add a chat with the bot’s current token.',
    reset_unavailable: 'Access cannot be reset until the bot state can be verified.',
    reset_required: 'The bot state needs a reset before this action can continue.',
    owner_conflict: 'Another cockpit owns this bot. Stop it there or choose another bot.',
    foreign_state: 'This bot belongs to another project. Choose another bot.',
    state_missing: 'The bot state is missing. Refresh the page and try again.',
    bot_busy: 'The bot is busy finishing another operation. Try again shortly.',
    replacement_required: 'This receiver’s bot or chat changed. Replace the pairing to continue.',
    already_paired: 'This person is already approved for this receiver, so no further approval is needed.',
    pairing_limit: 'Too many setup links are waiting. Wait five minutes or cancel one, then try again.',
    grant_limit: `This project has reached its ${name} access limit.`,
    comparison_required: `Compare the code sent privately by ${name} before approving.`,
    pairing_expired: 'This setup link expired. Create a new link and try again.',
    binding_missing: 'This bot is no longer assigned to this receiver. Refresh the page.',
    grant_missing: 'This approved person no longer exists. Refresh the page.',
    invalid_cursor: 'The activity history cursor is no longer valid. Refresh the history.',
    noncanonical_root: `${name} inbound access cannot run until the project path is canonical.`,
    expired: 'This setup link expired. Create a new link and try again.',
    not_found: `That ${name} pairing or receiver no longer exists. Refresh and try again.`,
  }
}

export function chatErrorCode(providerId: string, cause: unknown): string {
  const code = (cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '').toLowerCase()
  return code.startsWith(providerId) ? code.slice(providerId.length).replace(/^[_ -]/, '') : code
}

/** Only descriptor-owned copy may cross this boundary, never server prose or credentials. */
export function chatErrorMessage(provider: ChatProviderDescriptor, cause: unknown): string {
  const code = chatErrorCode(provider.id, cause)
  for (const messages of [provider.bot.settingsErrorMessages, provider.bot.setupErrorMessages]) {
    if (Object.hasOwn(messages, code)) return messages[code]!
  }
  return `${provider.name} could not complete that action. Refresh and try again.`
}
