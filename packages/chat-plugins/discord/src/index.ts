import { defineExtension } from '@open-mercato/cezar-extension-sdk'
import { createDiscordAdapter, discordRequest } from './adapter.js'
export { createDiscordAdapter, discordRequest } from './adapter.js'
export default defineExtension({ activate(context) { return context.chat.register('discord', credentials => createDiscordAdapter(credentials, discordRequest(credentials.token ?? ''), undefined, undefined, message => context.logger.error(message))) } })
