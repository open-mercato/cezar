import type { ChatProvider, ChatServiceDescriptor } from '../../provider.ts';
import { discordCredentialFields, decodeDiscordCredentials, discordChatId, snowflake } from './identity.ts';
import { discordPresentation } from './presentation.ts';
export const discordProvider: ChatProvider = {
 id: 'discord', label: 'Discord', credentials: discordCredentialFields,
 ids: { bot: snowflake, user: snowflake, message: snowflake, chat: discordChatId },
 limits: { maxText: 2000, buttonsPerMessage: 25, perChatPerSecond: 1, perBotPerSecond: 10 },
 renderText: discordPresentation.formatText, command: discordPresentation.command, discoveryLink: discordPresentation.discoveryLink,
};
export const discordServiceDescriptor: ChatServiceDescriptor = {
 ...discordProvider, format: 'discord.v1', presentation: discordPresentation,
 destination: credential => { decodeDiscordCredentials(credential); return 'https://discord.com/api/v10'; }, credentialBotId: () => undefined,
 adapterCredential: token => JSON.stringify({ token }),
};
