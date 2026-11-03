import { z } from 'zod';
import { telegramBotTokenSchema } from './webhooks.ts';

export const telegramDomainErrorSchema = z.object({ error: z.string(), code: z.string() });
export type TelegramDomainError = z.infer<typeof telegramDomainErrorSchema>;

const identifier = z.string().min(1).max(128);
export const telegramInboundIdSchema = z.string().regex(/^-?[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
export const telegramInboundRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
// `start` lets a person start new tasks with /task; like cancel/continue it is opt-in.
export const telegramInboundPermissionSchema = z.enum(['respond', 'start', 'cancel', 'continue']);
export const telegramInboundPermissionsSchema = z.array(telegramInboundPermissionSchema).min(1).max(4)
  .refine(value => value.includes('respond') && new Set(value).size === value.length);
export const telegramInboundGrantSchema = z.object({
  id: z.uuid(), receiverId: identifier, chatId: telegramInboundIdSchema, userId: telegramInboundIdSchema,
  label: z.string().max(256), permissions: telegramInboundPermissionsSchema,
  // Every grant is task control: notifications need no grant (spec 2026-10-29-telegram-setup-and-replies).
  capability: z.literal('task_control'),
  generation: z.uuid(), enableGeneration: z.uuid(), approvedAt: z.number().int().nonnegative().safe(),
});
export type TelegramInboundGrant = z.infer<typeof telegramInboundGrantSchema>;
export const telegramInboundHealthSchema = z.object({
  state: z.enum(['stopped', 'polling', 'backoff', 'conflict', 'credentials-unavailable', 'blocked']),
  lastSuccessfulPollAt: z.number().int().nonnegative().safe().optional(),
  droppedReplies: z.number().int().nonnegative().safe().optional(),
});
export const telegramInboundReceiverSchema = z.object({
  receiverId: identifier, botId: telegramInboundIdSchema.optional(), inboundRevision: telegramInboundRevisionSchema,
  state: z.enum(['disabled', 'pairing', 'active', 'suspended', 'credentials-unavailable', 'conflict', 'blocked', 'stopped']),
  generation: z.uuid().optional(),
  /** Why task control was suspended by Telegram itself: the bot left the group or the person blocked it in a private chat, or the group became a supergroup. */
  suspendedReason: z.enum(['bot_removed', 'group_migrated']).optional(),
});
const telegramUnavailableReasonSchema = z.enum(['flag_off', 'webhooks_off', 'hosted', 'unavailable']);
/** Notifications need CEZ_WEBHOOKS=1 alone; task control also needs CEZ_CHAT_INBOUND=1. */
export const telegramNotificationsAvailabilitySchema = z.object({ available: z.boolean(), reason: telegramUnavailableReasonSchema.exclude(['flag_off']).optional() });
export const telegramTaskControlAvailabilitySchema = z.object({ available: z.boolean(), reason: telegramUnavailableReasonSchema.optional() });
// `available`/`reason` keep describing task control; `notifications`/`taskControl` name each level.
export const telegramInboundStateResponseSchema = z.object({
  available: z.boolean(), reason: telegramUnavailableReasonSchema.optional(),
  notifications: telegramNotificationsAvailabilitySchema, taskControl: telegramTaskControlAvailabilitySchema,
  receivers: z.array(telegramInboundReceiverSchema),
  bots: z.array(z.object({ botId: telegramInboundIdSchema, username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).optional(),
    inboundRevision: telegramInboundRevisionSchema.optional(), health: telegramInboundHealthSchema })),
  grants: z.array(telegramInboundGrantSchema),
});
export type TelegramInboundStateResponse = z.infer<typeof telegramInboundStateResponseSchema>;
/** One guided setup for private and group receivers; the dedicated-bot acknowledgement is required before polling starts. */
export const telegramSetupBeginSchema = z.object({ receiverId: identifier, expectedRevision: telegramInboundRevisionSchema,
  token: telegramBotTokenSchema.optional(), name: z.string().trim().min(1).max(100).optional(),
  dedicatedBot: z.literal(true), replaceExisting: z.literal(true).optional(), groupVisibilityAccepted: z.literal(true).optional() }).or(z.object({
  receiverId: identifier.optional(), expectedRevision: telegramInboundRevisionSchema.optional(), token: telegramBotTokenSchema,
  name: z.string().trim().min(1).max(100).optional(), dedicatedBot: z.literal(true), replaceExisting: z.literal(true).optional(), groupVisibilityAccepted: z.literal(true).optional(),
}));
export type TelegramSetupBegin = z.infer<typeof telegramSetupBeginSchema>;
export const telegramSetupBotSchema = z.object({ id: telegramInboundIdSchema.refine(value => !value.startsWith('-')), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
export const telegramSetupBegunSchema = z.object({ setupId: z.uuid(), receiverId: identifier, bot: telegramSetupBotSchema,
  expiresAt: z.number().int().nonnegative().safe(), deepLink: z.string().url() });
export type TelegramSetupBegun = z.infer<typeof telegramSetupBegunSchema>;
/** A group candidate carries the comparison code the bot sent them privately. */
export const telegramSetupStatusSchema = z.object({ status: z.enum(['waiting', 'candidate', 'confirmed', 'expired']), receiverId: identifier,
  bot: telegramSetupBotSchema, inboundRevision: telegramInboundRevisionSchema,
  candidate: z.object({ userId: telegramInboundIdSchema, chatType: z.enum(['private', 'group']), label: z.string().max(256), username: z.string().max(64).optional(), comparisonCode: z.string().regex(/^[0-9]{6}$/).optional(),
    /** The group's title, once the setup discovered a group. */
    chatTitle: z.string().max(256).optional() }).optional() });
export type TelegramSetupStatus = z.infer<typeof telegramSetupStatusSchema>;
export const telegramSetupActivateSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, candidateUserId: telegramInboundIdSchema,
  comparisonVerified: z.literal(true).optional(), taskControl: z.boolean().optional(), permissions: telegramInboundPermissionsSchema.optional(), activate: z.literal(true),
  // A token-led setup that discovered a group needs the same group-visibility consent as an existing receiver.
  groupVisibilityAccepted: z.literal(true).optional() })
  .superRefine((value, ctx) => { if (value.taskControl !== false && !value.permissions) ctx.addIssue({ code: 'custom', message: 'Task-control permissions are required', path: ['permissions'] }); });
export type TelegramSetupActivate = z.infer<typeof telegramSetupActivateSchema>;
export const telegramSetupActivatedSchema = z.object({ grant: telegramInboundGrantSchema.optional(), receiverId: identifier.optional(), inboundRevision: telegramInboundRevisionSchema });
export type TelegramSetupActivated = z.infer<typeof telegramSetupActivatedSchema>;
export const telegramSetupCancelledSchema = z.object({ cancelled: z.literal(true) });
export const telegramInboundReceiverPatchSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, enabled: z.boolean(), groupVisibilityAccepted: z.literal(true).optional() });
export const telegramInboundReceiverPatchedSchema = z.object({ state: z.enum(['active', 'disabled']), inboundRevision: telegramInboundRevisionSchema });
export const telegramInboundGrantPatchSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, permissions: telegramInboundPermissionsSchema });
export const telegramInboundGrantPatchedSchema = z.object({ grant: telegramInboundGrantSchema, inboundRevision: telegramInboundRevisionSchema });
export const telegramInboundRevokedSchema = z.object({ revoked: z.literal(true), inboundRevision: telegramInboundRevisionSchema });
export const telegramInboundDisconnectedSchema = z.object({ disconnected: z.literal(true), inboundRevision: telegramInboundRevisionSchema });
export const telegramInboundResetSchema = z.object({ expectedRevision: telegramInboundRevisionSchema, confirmReset: z.literal(true) });
export const telegramInboundResetResponseSchema = z.object({ reset: z.literal(true), inboundRevision: telegramInboundRevisionSchema });
export const telegramInboundRevisionQuerySchema = z.object({ expectedRevision: telegramInboundRevisionSchema });
export const telegramInboundIdParamSchema = z.object({ id: z.uuid() });
export const telegramInboundBotParamSchema = z.object({ botId: telegramInboundIdSchema.refine(value => !value.startsWith('-')) });
export const telegramInboundActivityBaseSchema = z.object({
  id: z.uuid(), epoch: z.uuid(), updateId: z.number().int().nonnegative().safe(), at: z.number().int().nonnegative().safe(),
  botId: telegramInboundIdSchema, chatId: telegramInboundIdSchema.optional(), userId: telegramInboundIdSchema.optional(),
  receiverId: identifier.optional(), runId: identifier.optional(), actionId: identifier.optional(),
  kind: z.enum(['reply', 'answer', 'status', 'tasks', 'task', 'help', 'cancel', 'continue', 'unknown_command', 'rejection_summary']),
  reason: z.string().regex(/^[a-z_]{1,64}$/), count: z.number().int().positive().safe().optional(),
}).superRefine((row, ctx) => {
  if (row.kind === 'rejection_summary') {
    if (!['unauthorized', 'rate_limited'].includes(row.reason) || !row.count || row.at % 60_000 !== 0
      || row.userId !== undefined || row.chatId !== undefined || row.receiverId !== undefined || row.runId !== undefined || row.actionId !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Invalid bot-wide rejection summary' });
  } else if (!row.userId || !row.chatId || row.count !== undefined) ctx.addIssue({ code: 'custom', message: 'Individual action requires an actor and chat' });
});
export const telegramInboundActivitySchema = telegramInboundActivityBaseSchema.safeExtend({
  state: z.enum(['accepted', 'queued', 'deferred', 'rejected', 'uncertain']),
}).refine(row => row.kind !== 'rejection_summary' || row.state === 'rejected', 'Summary must be rejected');
export const telegramInboundActivityQuerySchema = z.object({ receiverId: identifier.optional(), before: identifier.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const telegramInboundActivityResponseSchema = z.object({ entries: z.array(telegramInboundActivitySchema), nextCursor: identifier.optional() });
export const telegramOrphanBindingSchema = z.object({ botId: telegramInboundIdSchema, projectId: identifier, projectName: z.string().max(256).optional(), orphaned: z.boolean(), inboundRevision: telegramInboundRevisionSchema });
export const telegramOrphanBindingsSchema = z.object({ bindings: z.array(telegramOrphanBindingSchema), truncated: z.boolean() });
export type TelegramOrphanBindings = z.infer<typeof telegramOrphanBindingsSchema>;
export const telegramOrphanReleasedSchema = z.object({ released: z.literal(true) });
export const telegramOrphanReleaseQuerySchema = telegramInboundRevisionQuerySchema.extend({ confirmOrphanRelease: z.literal('true') });

/** Generic invalidation only: no project, candidate, code or message on the bus. */
export const telegramInboundInvalidationSchema = z.object({ changed: z.literal(true) });
