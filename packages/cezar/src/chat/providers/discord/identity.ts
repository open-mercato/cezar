import { chatIdentifierSchemas } from '@open-mercato/cezar-contract';
import { z } from 'zod';
import { decodeChatCredentials } from '../../credentials.ts';
export const snowflake = chatIdentifierSchemas.discord.bot;
export const discordChatId = chatIdentifierSchemas.discord.chat;
export const discordCredentialFields = [{ name: 'token', label: 'Bot token', pattern: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}$/ }] as const;
export const decodeDiscordCredentials = (value: string) => decodeChatCredentials(discordCredentialFields, value).token!;
export function parseChat(id: string) {
 discordChatId.parse(id); const parts = id.split(':');
 return parts[1] === 'dm' ? { id, kind: 'private' as const, channel: parts[2]!, guild: undefined } : { id, kind: 'group' as const, guild: parts[2]!, channel: parts[3]! };
}
export const channelSchema = z.object({ id: snowflake, type: z.number().int(), guild_id: snowflake.optional(), recipients: z.array(z.object({ id: snowflake })).optional() });
export function channelIdentity(value: unknown) {
 const channel = channelSchema.parse(value);
 if (channel.type === 1 && !channel.guild_id) return { id: `discord:dm:${channel.id}`, kind: 'private' as const, channel };
 if (channel.type === 0 && channel.guild_id) return { id: `discord:guild:${channel.guild_id}:${channel.id}`, kind: 'group' as const, channel };
 throw new Error('Unsupported Discord channel');
}
