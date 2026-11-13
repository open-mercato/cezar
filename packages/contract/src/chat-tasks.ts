import { z } from 'zod';
import { chatOpaqueIdSchema, chatProviderIdSchema, chatIdentifierSchemas, chatDestinationMatchesBot } from './chat.ts';

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().safe();

export const chatTaskSourceStateSchema = z.enum([
  'received', 'claimed', 'uncertain', 'finished', 'expired', 'delivery_failed', 'policy_refused',
]);

export const chatTaskPolicyReasonSchema = z.enum([
  'account_unavailable', 'provider_unavailable', 'project_unavailable',
]);

/** Durable, private correlation. Prompt text and platform profile data never enter this record. */
const sourceSchema = z.strictObject({
  id: z.uuid(), provider: chatProviderIdSchema, botId: chatOpaqueIdSchema, epoch: z.uuid(), projectId: identifier, receiverId: identifier, grantId: z.uuid(),
  grantGeneration: z.uuid(), enableGeneration: z.uuid(), chatId: chatOpaqueIdSchema,
  userId: chatOpaqueIdSchema, sourceMessageId: z.string().min(1).max(128),
  replyTo: z.strictObject({ chatId: chatOpaqueIdSchema, messageId: chatOpaqueIdSchema }).optional(),
  updateId: z.number().int().nonnegative().safe(), episodeId: identifier, requestId: z.uuid(),
  runId: identifier.optional(), state: chatTaskSourceStateSchema,
  policyReason: chatTaskPolicyReasonSchema.optional(),
  createdAt: timestamp, updatedAt: timestamp,
});
export const chatSourceRecordSchema = sourceSchema.superRefine((source, ctx) => {
 const ids = source.provider === 'telegram' ? chatIdentifierSchemas[source.provider] : undefined;
 if (!chatDestinationMatchesBot(source.provider, source.chatId, source.botId)) ctx.addIssue({ code: 'custom', path: ['chatId'], message: 'Source destination belongs to another bot' });
 if (!ids) return;
 if (source.replyTo && (source.replyTo.chatId !== source.chatId || !ids.message.safeParse(source.replyTo.messageId).success)) ctx.addIssue({ code: 'custom', path: ['replyTo'], message: 'Invalid source thread receipt' });
 for (const [key, schema] of [['botId', ids.bot], ['userId', ids.user], ['chatId', ids.chat], ['sourceMessageId', ids.message]] as const) {
  if (!schema.safeParse(source[key]).success) ctx.addIssue({ code: 'custom', path: [key], message: 'Invalid provider identifier' });
 }
});

export const chatTaskCreateResultSchema = z.discriminatedUnion('created', [
  z.strictObject({ created: z.literal(true), runId: identifier }),
  z.strictObject({ created: z.literal(false), reason: z.enum(['account_unavailable', 'provider_unavailable', 'project_unavailable', 'creation_failed']) }),
]);

/** Where a task came from, as a run answers it: no chat, user, bot or message identifier, and no
 *  settlement state — the run keeps its creation snapshot, so a state there would always read `claimed`. */
export const chatSourceProvenanceSchema = sourceSchema.pick({ provider: true, id: true, projectId: true, receiverId: true, requestId: true, runId: true, createdAt: true });
export type ChatSourceRecord = z.infer<typeof chatSourceRecordSchema>;
export type ChatSourceProvenance = z.infer<typeof chatSourceProvenanceSchema>;
export type ChatTaskCreateResult = z.infer<typeof chatTaskCreateResultSchema>;
