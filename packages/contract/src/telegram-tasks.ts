import { z } from 'zod';
import { telegramInboundIdSchema } from './telegram.ts';

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().safe();

export const telegramTaskSourceStateSchema = z.enum([
  'received', 'claimed', 'uncertain', 'finished', 'expired', 'delivery_failed', 'policy_refused',
]);

export const telegramTaskPolicyReasonSchema = z.enum([
  'account_unavailable', 'provider_unavailable', 'project_unavailable',
]);

/** Durable, private correlation. Prompt text and Telegram profile data never enter this record. */
export const telegramSourceRecordSchema = z.strictObject({
  id: z.uuid(), botId: telegramInboundIdSchema, epoch: z.uuid(), projectId: identifier, receiverId: identifier, grantId: z.uuid(),
  grantGeneration: z.uuid(), enableGeneration: z.uuid(), chatId: telegramInboundIdSchema,
  userId: telegramInboundIdSchema, sourceMessageId: z.number().int().positive().safe(),
  updateId: z.number().int().nonnegative().safe(), episodeId: identifier, requestId: z.uuid(),
  runId: identifier.optional(), state: telegramTaskSourceStateSchema,
  policyReason: telegramTaskPolicyReasonSchema.optional(),
  createdAt: timestamp, updatedAt: timestamp,
});
export type TelegramSourceRecord = z.infer<typeof telegramSourceRecordSchema>;

export const telegramTaskCreateResultSchema = z.discriminatedUnion('created', [
  z.strictObject({ created: z.literal(true), runId: identifier }),
  z.strictObject({ created: z.literal(false), reason: z.enum(['account_unavailable', 'provider_unavailable', 'project_unavailable', 'creation_failed']) }),
]);
export type TelegramTaskCreateResult = z.infer<typeof telegramTaskCreateResultSchema>;

/** Where a task came from, as a run answers it: no chat, user, bot or message identifier, and no
 *  settlement state — the run keeps its creation snapshot, so a state there would always read `claimed`. */
export const telegramSourceProvenanceSchema = telegramSourceRecordSchema.pick({
  id: true, projectId: true, receiverId: true, requestId: true, runId: true, createdAt: true,
});
export type TelegramSourceProvenance = z.infer<typeof telegramSourceProvenanceSchema>;
