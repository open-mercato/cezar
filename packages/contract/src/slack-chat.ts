import { z } from 'zod';
import { chatSchemas } from './chat.ts';
export const slackChatIdSchema = z.string().regex(/^(private|group):T[A-Z0-9]+:U[A-Z0-9]+:[CDG][A-Z0-9]+$/);
export const slackBotIdSchema = z.string().regex(/^T[A-Z0-9]+:U[A-Z0-9]+$/);
export const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]+$/);
export const slackAppTokenPattern = /^(?:xapp-|xoxe\.xapp-)[A-Za-z0-9-]{10,2000}$/;
export const slackBotTokenPattern = /^(?:xoxb-|xoxe\.xoxb-)[A-Za-z0-9-]{10,2000}$/;
export const slackRefreshTokenPattern = /^xoxe-[A-Za-z0-9-]{10,2000}$/;
export const slackCredentialRecordSchema = z.strictObject({
 appToken: z.string().regex(slackAppTokenPattern),
 botToken: z.string().regex(slackBotTokenPattern),
 appRefreshToken: z.string().regex(slackRefreshTokenPattern).optional(),
 botRefreshToken: z.string().regex(slackRefreshTokenPattern).optional(),
 clientId: z.string().regex(/^\d+\.\d+$/).max(128).optional(),
 clientSecret: z.string().regex(/^[A-Za-z0-9]{16,256}$/).optional(),
}).superRefine((value, ctx) => {
 for (const kind of ['app', 'bot'] as const) {
  if (value[`${kind}Token`].startsWith('xoxe.') && (!value[`${kind}RefreshToken`] || !value.clientId || !value.clientSecret))
   ctx.addIssue({ code: 'custom', path: [`${kind}RefreshToken`], message: 'Automatic renewal needs the refresh token, Client ID and Client Secret.' });
 }
});
export const slackCredentialSchema = z.string().min(1).max(16384).refine(value => {
 try { return slackCredentialRecordSchema.safeParse(JSON.parse(value)).success; } catch { return false; }
}, 'Invalid Slack credentials');
// The shared factory uses this union for mixed bot/chat/user fields; persistence uses role-specific IDs.
export const slackSchemas = chatSchemas(z.union([slackChatIdSchema, slackBotIdSchema, slackUserIdSchema]), slackBotIdSchema, slackBotIdSchema, slackCredentialSchema);
export type SlackCredentials = z.infer<typeof slackCredentialRecordSchema>;
