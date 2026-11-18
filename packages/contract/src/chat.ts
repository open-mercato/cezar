import { z } from 'zod';
export const chatExtensionProviderIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}\/[a-z][a-z0-9_-]{0,63}$/);
export const chatProviderIdSchema = z.union([z.enum(['telegram']), chatExtensionProviderIdSchema]);
export const extensionChatRouteParamsSchema = z.object({ extensionId: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/), providerId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/) });
export const chatOpaqueIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@-]+$/);
/** One HTTP definition; providers supply only their identifier/credential constraints. */
export function chatSchemas(ids: z.ZodType<string>, botId: z.ZodType<string>, username: z.ZodType<string>, credential: z.ZodType<string>) {
const chatDomainErrorSchema = z.object({ error: z.string(), code: z.string() });

const identifier = z.string().min(1).max(128);
const chatInboundIdSchema = ids;
const chatInboundRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
// `start` lets a person start new tasks with /task; like cancel/continue it is opt-in.
const chatInboundPermissionSchema = z.enum(['respond', 'start', 'cancel', 'continue']);
const chatInboundPermissionsSchema = z.array(chatInboundPermissionSchema).min(1).max(4)
  .refine(value => value.includes('respond') && new Set(value).size === value.length);
const chatInboundGrantSchema = z.object({
  id: z.uuid(), receiverId: identifier, chatId: chatInboundIdSchema, userId: chatInboundIdSchema,
  label: z.string().max(256), permissions: chatInboundPermissionsSchema,
  // Every grant is task control: notifications need no grant (spec 2026-10-29-telegram-setup-and-replies).
  capability: z.literal('task_control'),
  generation: z.uuid(), enableGeneration: z.uuid(), approvedAt: z.number().int().nonnegative().safe(),
});
const chatInboundHealthSchema = z.object({
  state: z.enum(['stopped', 'polling', 'backoff', 'conflict', 'credentials-unavailable', 'blocked']),
  lastSuccessfulPollAt: z.number().int().nonnegative().safe().optional(),
  droppedReplies: z.number().int().nonnegative().safe().optional(),
  /** Additive: a `stopped` bot whose runtime is starting or not yet connected. */
  connecting: z.literal(true).optional(),
});
const chatInboundReceiverSchema = z.object({
  receiverId: identifier, botId: chatInboundIdSchema.optional(), inboundRevision: chatInboundRevisionSchema,
  state: z.enum(['disabled', 'pairing', 'active', 'suspended', 'credentials-unavailable', 'conflict', 'blocked', 'stopped']),
  generation: z.uuid().optional(),
  /** Why task control was suspended by Telegram itself: the bot left the group or the person blocked it in a private chat, or the group became a supergroup. */
  suspendedReason: z.enum(['bot_removed', 'group_migrated']).optional(),
});
const chatUnavailableReasonSchema = z.enum(['flag_off', 'webhooks_off', 'hosted', 'unavailable']);
/** Notifications need CEZ_WEBHOOKS=1 alone; task control also needs CEZ_CHAT_INBOUND=1. */
const chatNotificationsAvailabilitySchema = z.object({ available: z.boolean(), reason: chatUnavailableReasonSchema.exclude(['flag_off']).optional() });
const chatTaskControlAvailabilitySchema = z.object({ available: z.boolean(), reason: chatUnavailableReasonSchema.optional() });
// `available`/`reason` keep describing task control; `notifications`/`taskControl` name each level.
const chatInboundStateResponseSchema = z.object({
  available: z.boolean(), reason: chatUnavailableReasonSchema.optional(),
  notifications: chatNotificationsAvailabilitySchema, taskControl: chatTaskControlAvailabilitySchema,
  receivers: z.array(chatInboundReceiverSchema),
  bots: z.array(z.object({ botId: chatInboundIdSchema, username: username.optional(),
    inboundRevision: chatInboundRevisionSchema.optional(), health: chatInboundHealthSchema })),
  grants: z.array(chatInboundGrantSchema),
});
/** One guided setup for private and group receivers; the dedicated-bot acknowledgement is required before polling starts. */
const chatSetupBeginSchema = z.object({ receiverId: identifier, expectedRevision: chatInboundRevisionSchema,
  token: credential.optional(), name: z.string().trim().min(1).max(100).optional(),
  dedicatedBot: z.literal(true), replaceExisting: z.literal(true).optional(), groupVisibilityAccepted: z.literal(true).optional() }).or(z.object({
  receiverId: identifier.optional(), expectedRevision: chatInboundRevisionSchema.optional(), token: credential,
  name: z.string().trim().min(1).max(100).optional(), dedicatedBot: z.literal(true), replaceExisting: z.literal(true).optional(), groupVisibilityAccepted: z.literal(true).optional(),
}));
const chatSetupBotSchema = z.object({ id: botId, username: username });
const chatSetupBegunSchema = z.object({ setupId: z.uuid(), receiverId: identifier, bot: chatSetupBotSchema,
  expiresAt: z.number().int().nonnegative().safe(), deepLink: z.string().url() });
/** A group candidate carries the comparison code the bot sent them privately. */
const chatSetupStatusSchema = z.object({ status: z.enum(['waiting', 'candidate', 'confirmed', 'expired']), receiverId: identifier,
  bot: chatSetupBotSchema, inboundRevision: chatInboundRevisionSchema,
  candidate: z.object({ userId: chatInboundIdSchema, chatType: z.enum(['private', 'group']), label: z.string().max(256), username: z.string().max(64).optional(), comparisonCode: z.string().regex(/^[0-9]{6}$/).optional(),
    /** The group's title, once the setup discovered a group. */
    chatTitle: z.string().max(256).optional() }).optional() });
const chatSetupActivateSchema = z.object({ expectedRevision: chatInboundRevisionSchema, candidateUserId: chatInboundIdSchema,
  comparisonVerified: z.literal(true).optional(), taskControl: z.boolean().optional(), permissions: chatInboundPermissionsSchema.optional(), activate: z.literal(true),
  // A token-led setup that discovered a group needs the same group-visibility consent as an existing receiver.
  groupVisibilityAccepted: z.literal(true).optional() })
  .superRefine((value, ctx) => { if (value.taskControl !== false && !value.permissions) ctx.addIssue({ code: 'custom', message: 'Task-control permissions are required', path: ['permissions'] }); });
const chatSetupActivatedSchema = z.object({ grant: chatInboundGrantSchema.optional(), receiverId: identifier.optional(), inboundRevision: chatInboundRevisionSchema });
const chatSetupCancelledSchema = z.object({ cancelled: z.literal(true) });
const chatInboundReceiverPatchSchema = z.object({ expectedRevision: chatInboundRevisionSchema, enabled: z.boolean(), groupVisibilityAccepted: z.literal(true).optional() });
const chatInboundReceiverPatchedSchema = z.object({ state: z.enum(['active', 'disabled']), inboundRevision: chatInboundRevisionSchema });
const chatInboundGrantPatchSchema = z.object({ expectedRevision: chatInboundRevisionSchema, permissions: chatInboundPermissionsSchema });
const chatInboundGrantPatchedSchema = z.object({ grant: chatInboundGrantSchema, inboundRevision: chatInboundRevisionSchema });
const chatInboundRevokedSchema = z.object({ revoked: z.literal(true), inboundRevision: chatInboundRevisionSchema });
const chatInboundDisconnectedSchema = z.object({ disconnected: z.literal(true), inboundRevision: chatInboundRevisionSchema });
const chatInboundResetSchema = z.object({ expectedRevision: chatInboundRevisionSchema, confirmReset: z.literal(true) });
const chatInboundResetResponseSchema = z.object({ reset: z.literal(true), inboundRevision: chatInboundRevisionSchema });
const chatInboundRevisionQuerySchema = z.object({ expectedRevision: chatInboundRevisionSchema });
const chatInboundIdParamSchema = extensionChatRouteParamsSchema.partial().extend({ id: z.uuid() });
const chatInboundBotParamSchema = extensionChatRouteParamsSchema.partial().extend({ botId: botId });
const chatInboundActivityBaseSchema = z.object({
  id: z.uuid(), epoch: z.uuid(), updateId: z.number().int().nonnegative().safe(), at: z.number().int().nonnegative().safe(),
  botId: chatInboundIdSchema, chatId: chatInboundIdSchema.optional(), userId: chatInboundIdSchema.optional(),
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
const chatInboundActivitySchema = chatInboundActivityBaseSchema.safeExtend({
  state: z.enum(['accepted', 'queued', 'deferred', 'rejected', 'uncertain']),
}).refine(row => row.kind !== 'rejection_summary' || row.state === 'rejected', 'Summary must be rejected');
const chatInboundActivityQuerySchema = z.object({ receiverId: identifier.optional(), before: identifier.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const chatInboundActivityResponseSchema = z.object({ entries: z.array(chatInboundActivitySchema), nextCursor: identifier.optional() });
const chatOrphanBindingSchema = z.object({ botId: chatInboundIdSchema, projectId: identifier, projectName: z.string().max(256).optional(), orphaned: z.boolean(), inboundRevision: chatInboundRevisionSchema });
const chatOrphanBindingsSchema = z.object({ bindings: z.array(chatOrphanBindingSchema), truncated: z.boolean() });
const chatOrphanReleasedSchema = z.object({ released: z.literal(true) });
const chatOrphanReleaseQuerySchema = chatInboundRevisionQuerySchema.extend({ confirmOrphanRelease: z.literal('true') });

/** Generic invalidation only: no project, candidate, code or message on the bus. */
const chatInboundInvalidationSchema = z.object({ changed: z.literal(true) });

return { chatDomainErrorSchema, chatInboundIdSchema, chatInboundRevisionSchema, chatInboundPermissionSchema, chatInboundPermissionsSchema, chatInboundGrantSchema, chatInboundHealthSchema, chatInboundReceiverSchema, chatNotificationsAvailabilitySchema, chatTaskControlAvailabilitySchema, chatInboundStateResponseSchema, chatSetupBeginSchema, chatSetupBotSchema, chatSetupBegunSchema, chatSetupStatusSchema, chatSetupActivateSchema, chatSetupActivatedSchema, chatSetupCancelledSchema, chatInboundReceiverPatchSchema, chatInboundReceiverPatchedSchema, chatInboundGrantPatchSchema, chatInboundGrantPatchedSchema, chatInboundRevokedSchema, chatInboundDisconnectedSchema, chatInboundResetSchema, chatInboundResetResponseSchema, chatInboundRevisionQuerySchema, chatInboundIdParamSchema, chatInboundBotParamSchema, chatInboundActivityBaseSchema, chatInboundActivitySchema, chatInboundActivityQuerySchema, chatInboundActivityResponseSchema, chatOrphanBindingSchema, chatOrphanBindingsSchema, chatOrphanReleasedSchema, chatOrphanReleaseQuerySchema, chatInboundInvalidationSchema };
}
const shared = chatSchemas(chatOpaqueIdSchema, chatOpaqueIdSchema, z.string().min(1).max(128), z.string().min(1).max(16384));
export const chatDomainErrorSchema = shared.chatDomainErrorSchema;
export const chatInboundIdSchema = shared.chatInboundIdSchema;
export const chatInboundRevisionSchema = shared.chatInboundRevisionSchema;
export const chatInboundPermissionSchema = shared.chatInboundPermissionSchema;
export const chatInboundPermissionsSchema = shared.chatInboundPermissionsSchema;
export const chatInboundGrantSchema = shared.chatInboundGrantSchema;
export const chatInboundHealthSchema = shared.chatInboundHealthSchema;
export const chatInboundReceiverSchema = shared.chatInboundReceiverSchema;
export const chatNotificationsAvailabilitySchema = shared.chatNotificationsAvailabilitySchema;
export const chatTaskControlAvailabilitySchema = shared.chatTaskControlAvailabilitySchema;
export const chatInboundStateResponseSchema = shared.chatInboundStateResponseSchema;
export const chatSetupBeginSchema = shared.chatSetupBeginSchema;
export const chatSetupBotSchema = shared.chatSetupBotSchema;
export const chatSetupBegunSchema = shared.chatSetupBegunSchema;
export const chatSetupStatusSchema = shared.chatSetupStatusSchema;
export const chatSetupActivateSchema = shared.chatSetupActivateSchema;
export const chatSetupActivatedSchema = shared.chatSetupActivatedSchema;
export const chatSetupCancelledSchema = shared.chatSetupCancelledSchema;
export const chatInboundReceiverPatchSchema = shared.chatInboundReceiverPatchSchema;
export const chatInboundReceiverPatchedSchema = shared.chatInboundReceiverPatchedSchema;
export const chatInboundGrantPatchSchema = shared.chatInboundGrantPatchSchema;
export const chatInboundGrantPatchedSchema = shared.chatInboundGrantPatchedSchema;
export const chatInboundRevokedSchema = shared.chatInboundRevokedSchema;
export const chatInboundDisconnectedSchema = shared.chatInboundDisconnectedSchema;
export const chatInboundResetSchema = shared.chatInboundResetSchema;
export const chatInboundResetResponseSchema = shared.chatInboundResetResponseSchema;
export const chatInboundRevisionQuerySchema = shared.chatInboundRevisionQuerySchema;
export const chatInboundIdParamSchema = shared.chatInboundIdParamSchema;
export const chatInboundBotParamSchema = shared.chatInboundBotParamSchema;
export const chatInboundActivityBaseSchema = shared.chatInboundActivityBaseSchema;
export const chatInboundActivitySchema = shared.chatInboundActivitySchema;
export const chatInboundActivityQuerySchema = shared.chatInboundActivityQuerySchema;
export const chatInboundActivityResponseSchema = shared.chatInboundActivityResponseSchema;
export const chatOrphanBindingSchema = shared.chatOrphanBindingSchema;
export const chatOrphanBindingsSchema = shared.chatOrphanBindingsSchema;
export const chatOrphanReleasedSchema = shared.chatOrphanReleasedSchema;
export const chatOrphanReleaseQuerySchema = shared.chatOrphanReleaseQuerySchema;
export const chatInboundInvalidationSchema = shared.chatInboundInvalidationSchema;
/** Platform constraints are checked at persistence/HTTP boundaries; orchestration treats IDs as opaque. */
const telegramIdentifier = z.string().regex(/^-?[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const telegramPositiveIdentifier = telegramIdentifier.refine(value => !value.startsWith('-'));
export const chatIdentifierSchemas = {
 telegram: { bot: telegramPositiveIdentifier, user: telegramPositiveIdentifier, chat: telegramIdentifier, message: telegramPositiveIdentifier },
} as const;
const opaqueIdentifierSchemas = { bot: chatOpaqueIdSchema, user: chatOpaqueIdSchema, chat: chatOpaqueIdSchema, message: chatOpaqueIdSchema };
export function chatIdentifierSchemaFor(provider: z.infer<typeof chatProviderIdSchema>) {
 return provider === 'telegram' ? chatIdentifierSchemas[provider] : opaqueIdentifierSchemas;
}
const builtinProvider = (provider: z.infer<typeof chatProviderIdSchema>): keyof typeof chatIdentifierSchemas | undefined => provider === 'telegram' ? provider : undefined;

/** Qualified destinations retain privacy; a Telegram chat id does not, so it is never qualified. */
export function qualifiedChatKind(provider: z.infer<typeof chatProviderIdSchema>, id: string): 'private' | 'group' | undefined {
 const builtin = builtinProvider(provider); if (!builtin || !chatIdentifierSchemas[builtin].chat.safeParse(id).success) return;
 return undefined;
}
export function chatDestinationMatchesBot(provider: z.infer<typeof chatProviderIdSchema>, id: string, botId: string): boolean {
 const builtin = builtinProvider(provider); return builtin ? chatIdentifierSchemas[builtin].chat.safeParse(id).success : chatOpaqueIdSchema.safeParse(id).success;
}

// Generic types derive from the same schemas used by middleware and persistence.
export type ChatDomainError = z.infer<typeof chatDomainErrorSchema>;
export type ChatInboundId = z.infer<typeof chatInboundIdSchema>;
export type ChatInboundRevision = z.infer<typeof chatInboundRevisionSchema>;
export type ChatInboundPermission = z.infer<typeof chatInboundPermissionSchema>;
export type ChatInboundPermissions = z.infer<typeof chatInboundPermissionsSchema>;
export type ChatInboundGrant = z.infer<typeof chatInboundGrantSchema>;
export type ChatInboundHealth = z.infer<typeof chatInboundHealthSchema>;
export type ChatInboundReceiver = z.infer<typeof chatInboundReceiverSchema>;
export type ChatNotificationsAvailability = z.infer<typeof chatNotificationsAvailabilitySchema>;
export type ChatTaskControlAvailability = z.infer<typeof chatTaskControlAvailabilitySchema>;
export type ChatInboundStateResponse = z.infer<typeof chatInboundStateResponseSchema>;
export type ChatSetupBegin = z.infer<typeof chatSetupBeginSchema>;
export type ChatSetupBot = z.infer<typeof chatSetupBotSchema>;
export type ChatSetupBegun = z.infer<typeof chatSetupBegunSchema>;
export type ChatSetupStatus = z.infer<typeof chatSetupStatusSchema>;
export type ChatSetupActivate = z.infer<typeof chatSetupActivateSchema>;
export type ChatSetupActivated = z.infer<typeof chatSetupActivatedSchema>;
export type ChatSetupCancelled = z.infer<typeof chatSetupCancelledSchema>;
export type ChatInboundReceiverPatch = z.infer<typeof chatInboundReceiverPatchSchema>;
export type ChatInboundReceiverPatched = z.infer<typeof chatInboundReceiverPatchedSchema>;
export type ChatInboundGrantPatch = z.infer<typeof chatInboundGrantPatchSchema>;
export type ChatInboundGrantPatched = z.infer<typeof chatInboundGrantPatchedSchema>;
export type ChatInboundRevoked = z.infer<typeof chatInboundRevokedSchema>;
export type ChatInboundDisconnected = z.infer<typeof chatInboundDisconnectedSchema>;
export type ChatInboundReset = z.infer<typeof chatInboundResetSchema>;
export type ChatInboundResetResponse = z.infer<typeof chatInboundResetResponseSchema>;
export type ChatInboundRevisionQuery = z.infer<typeof chatInboundRevisionQuerySchema>;
export type ChatInboundIdParam = z.infer<typeof chatInboundIdParamSchema>;
export type ChatInboundBotParam = z.infer<typeof chatInboundBotParamSchema>;
export type ChatInboundActivityBase = z.infer<typeof chatInboundActivityBaseSchema>;
export type ChatInboundActivity = z.infer<typeof chatInboundActivitySchema>;
export type ChatInboundActivityQuery = z.infer<typeof chatInboundActivityQuerySchema>;
export type ChatInboundActivityResponse = z.infer<typeof chatInboundActivityResponseSchema>;
export type ChatOrphanBinding = z.infer<typeof chatOrphanBindingSchema>;
export type ChatOrphanBindings = z.infer<typeof chatOrphanBindingsSchema>;
export type ChatOrphanReleased = z.infer<typeof chatOrphanReleasedSchema>;
export type ChatOrphanReleaseQuery = z.infer<typeof chatOrphanReleaseQuerySchema>;
export type ChatInboundInvalidation = z.infer<typeof chatInboundInvalidationSchema>;
