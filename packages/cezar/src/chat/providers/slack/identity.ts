import { z } from 'zod';
import { ChatSecretError } from '../../credentials.ts';
import { slackCredentialRecordSchema, slackAppTokenPattern, slackBotTokenPattern, slackRefreshTokenPattern } from '@open-mercato/cezar-contract';
export const slackCredentials = [
 { name: 'appToken', label: 'App-level token', pattern: slackAppTokenPattern },
 { name: 'botToken', label: 'Bot token', pattern: slackBotTokenPattern },
 { name: 'appRefreshToken', label: 'App refresh token', pattern: slackRefreshTokenPattern, optional: true },
 { name: 'botRefreshToken', label: 'Bot refresh token', pattern: slackRefreshTokenPattern, optional: true },
 { name: 'clientId', label: 'Client ID', pattern: /^\d+\.\d+$/, optional: true },
 { name: 'clientSecret', label: 'Client Secret', pattern: /^[A-Za-z0-9]{16,256}$/, optional: true },
] as const;
export const slackIds = {
 bot: z.string().regex(/^T[A-Z0-9]+:U[A-Z0-9]+$/),
 user: z.string().regex(/^[UW][A-Z0-9]+$/),
 chat: z.string().regex(/^(private|group):T[A-Z0-9]+:U[A-Z0-9]+:[CDG][A-Z0-9]+$/),
 message: z.string().regex(/^\d{10,16}\.\d{6}$/),
};
export const decodeSlackCredentials = (value: string) => {
 try { return slackCredentialRecordSchema.parse(JSON.parse(value)); } catch { throw new ChatSecretError(); }
};
export const encodeSlackCredentials = (values: Record<string, string>) => JSON.stringify(decodeSlackCredentials(JSON.stringify(values)));
export function slackChat(id: string) {
 slackIds.chat.parse(id);
 const [kind, team, bot, channel] = id.split(':') as ['private' | 'group', string, string, string];
 return { kind, team, bot, channel, botId: `${team}:${bot}` };
}
