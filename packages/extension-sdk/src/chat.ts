import { z } from 'zod'
export const chatIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@-]+$/);
export const chatRefSchema = z.object({ id: chatIdSchema, kind: z.enum(['private', 'group']) });
export const chatReceiptSchema = z.object({ messageId: chatIdSchema, chatId: chatIdSchema });
export const chatButtonSchema = z.object({ text: z.string().min(1), data: z.string().min(1).max(128) });
/** Omit textFormat for untrusted literal text. Explicit platform formats require
 * already escaped renderer output; adapters reject unsupported or unsafe markup. */
export const chatMessageSchema = z.object({ text: z.string(), textFormat: z.enum(['plain', 'telegram-html', 'slack-mrkdwn']).optional(), replyTo: chatReceiptSchema.optional(), buttons: z.array(z.array(chatButtonSchema)).optional() });
export const chatIdentitySchema = z.object({ id: chatIdSchema, username: z.string().min(1).max(128), discoveryUrl: z.string().url().refine(value => value.startsWith('https://')).optional() });
export const chatCredentialsSchema = z.record(z.string(), z.string());
export const chatFailureSchema = z.object({ kind: z.enum(['auth', 'conflict', 'rate_limited', 'gone', 'transient', 'blocked']), retryAfterMs: z.number().finite().positive().optional() });
export type ChatFailure = z.infer<typeof chatFailureSchema>;
export type ChatRef = z.infer<typeof chatRefSchema>;
export type ChatReceipt = z.infer<typeof chatReceiptSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatIdentity = z.infer<typeof chatIdentitySchema>;
export type ChatCredentials = z.infer<typeof chatCredentialsSchema>;
const actor = z.object({ id: chatIdSchema, label: z.string().max(256), username: z.string().max(128).optional() });
const base = { id: chatIdSchema, chat: chatRefSchema };
export const chatEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('message'), user: actor, messageId: chatIdSchema, at: z.number().int().nonnegative(), text: z.string().max(65536), addressed: z.boolean(), pairingEligible: z.boolean().optional(), replyTo: chatReceiptSchema.optional() }),
  z.object({ ...base, kind: z.literal('button'), user: actor, receipt: chatReceiptSchema, data: z.string().max(128) }),
  z.object({ ...base, kind: z.literal('membership'), reason: z.enum(['removed', 'migrated']), previousChatId: chatIdSchema.optional() }),
  z.object({ ...base, kind: z.literal('start'), user: actor, at: z.number().int().nonnegative(), code: z.string().max(128), title: z.string().max(256).optional() }),
]).superRefine((event, ctx) => {
 const receipt = event.kind === 'message' ? event.replyTo : event.kind === 'button' ? event.receipt : undefined;
 if (receipt && receipt.chatId !== event.chat.id) ctx.addIssue({ code: 'custom', message: 'Receipt belongs to another chat' });
});
export type ChatEvent = z.infer<typeof chatEventSchema>;

export const chatCommandClassificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), name: z.enum(['start', 'task', 'tasks', 'status', 'reply', 'cancel', 'continue', 'help']), args: z.string().max(65536) }).strict(),
  z.object({ kind: z.enum(['ignore', 'text', 'unknown']) }).strict(),
])
// Session deliveries are strict at every level; chatEventSchema stays the core's permissive shape.
const sessionIdentity = { chat: chatRefSchema.strict() }
const sessionActor = { user: actor.strict() }
export const chatSessionEventSchema = z.discriminatedUnion('kind', [
  chatEventSchema.options[0].extend({
    ...sessionIdentity, ...sessionActor, replyTo: chatReceiptSchema.strict().optional(),
    command: chatCommandClassificationSchema.optional(), title: z.string().max(256).optional(),
  }).strict(),
  chatEventSchema.options[1].extend({ ...sessionIdentity, ...sessionActor, receipt: chatReceiptSchema.strict() }).strict(),
  chatEventSchema.options[2].extend({
    ...sessionIdentity, affectedChatIds: z.array(chatIdSchema).min(1).max(10).optional(),
  }).strict(),
  chatEventSchema.options[3].extend({ ...sessionIdentity, ...sessionActor }).strict(),
]).superRefine((event, ctx) => {
  const receipt = event.kind === 'message' ? event.replyTo : event.kind === 'button' ? event.receipt : undefined
  if (receipt && receipt.chatId !== event.chat.id) ctx.addIssue({ code: 'custom', message: 'Receipt belongs to another chat' })
  if (event.kind === 'membership' && event.affectedChatIds) {
    if (!event.affectedChatIds.includes(event.chat.id) ||
      (event.previousChatId && !event.affectedChatIds.includes(event.previousChatId)) ||
      new Set(event.affectedChatIds).size !== event.affectedChatIds.length) {
      ctx.addIssue({ code: 'custom', message: 'Affected destinations must be unique and include the membership identities' })
    }
  }
})
export type ChatSessionEvent = z.infer<typeof chatSessionEventSchema>
export const chatTaskQuerySchema = z.string().max(128)
/** Host assigns health timestamps; reports describe status only. Backoff may
 * recover in-session, while blocked/conflict/credentials-unavailable need intervention. */
export const chatReceiveHealthSchema = z.object({
  state: z.enum(['stopped', 'connecting', 'polling', 'backoff', 'conflict', 'credentials-unavailable', 'blocked']),
}).strict()
export type ChatReceiveHealth = z.infer<typeof chatReceiveHealthSchema>

/** Host-owned checkpoint. A null nextSequence means the platform has not supplied
 * an ordered offset yet; it is not permission to invent a socket replay cursor. */
export const chatCheckpointSchema = z.object({
  epoch: z.string().uuid(),
  nextSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
}).strict()
export const chatDeliverySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ordered'), epoch: z.string().uuid(),
    // The journal must be able to persist sequence + 1 without rounding.
    sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
    event: chatSessionEventSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('event'), event: chatSessionEventSchema }).strict(),
])
export const chatAcceptedSchema = z.object({
  disposition: z.enum(['accepted', 'duplicate']), checkpoint: chatCheckpointSchema,
}).strict()
export const chatInteractionInputSchema = z.object({
  kind: z.literal('task-autocomplete'), eventId: chatIdSchema,
  chat: chatRefSchema.strict(), user: actor.strict(),
  at: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()
export const chatTaskChoicesSchema = z.array(z.object({
  name: z.string().min(1).max(100), value: z.string().min(1).max(100),
}).strict()).max(25)
export type ChatCheckpoint = z.infer<typeof chatCheckpointSchema>
export type ChatDelivery = z.infer<typeof chatDeliverySchema>
export type ChatAccepted = z.infer<typeof chatAcceptedSchema>
export type ChatInteractionInput = z.infer<typeof chatInteractionInputSchema>
export type ChatTaskChoices = z.infer<typeof chatTaskChoicesSchema>

export const extensionChatProviderSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().min(1).max(100),
  receiveModel: z.enum(['ordered', 'opaque']),
  credentialProfile: z.literal('slack-oauth-v1').optional(),
  credentials: z.array(z.object({ name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), label: z.string().min(1).max(100), secret: z.boolean().default(true), optional: z.boolean().optional() }).strict()).min(1).max(10),
  limits: z.object({ maxText: z.number().int().min(100).max(20000), buttonsPerMessage: z.number().int().min(0).max(100), perChatPerSecond: z.number().positive().max(100), perBotPerSecond: z.number().positive().max(1000) }).strict(),
  /** External IDs must distinguish private and group destinations. */
  commandPrefix: z.string().min(1).max(30).default('/'),
  groupPrefix: z.string().min(1).max(50).default('group:'),
  /** Setup help link, and the pairing link base when identify() returns no discoveryUrl. */
  discoveryUrl: z.string().url().refine(value => value.startsWith('https://'), 'discovery URL must use HTTPS'),
  pairingLink: z.string().max(2048).refine(value => { return value.startsWith('https://') && z.string().url().safeParse(value.replaceAll('{username}', 'bot').replaceAll('{code}', 'code')).success && !/\{(?!username\}|code\})/.test(value) }, 'invalid HTTPS pairing template').optional(),
}).strict()
export type ExtensionChatProvider = z.infer<typeof extensionChatProviderSchema>
// Structural AbortSignal surface keeps the SDK independent of Node and DOM type libraries.
export interface ExtensionChatOperationContext {
  readonly signal: {
    readonly aborted: boolean
    throwIfAborted(): void
    addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
    removeEventListener(type: 'abort', listener: () => void): void
  }
  /** Await after asynchronous preparation, immediately before each external effect.
   * An adapter that ignores the optional context cannot cancel pending effects. */
  assertActive(): Promise<void>
}
/** Bound to one host-selected bot and credential generation, not an arbitrary
 * vault key. Without it the factory receives the stored credential fields. */
export interface ChatBotServices {
  readonly credentials?: {
    accessToken(slot: 'app' | 'bot', operation: ExtensionChatOperationContext): Promise<string>
  }
}
/** A short-lived, host-authorized interaction. It cannot change actor/project,
 * bypass grants, list arbitrary tasks, or launch work. Wire tokens stay in the adapter. */
export interface ChatInteractionContext extends ExtensionChatOperationContext {
  taskChoices(query: string): Promise<ChatTaskChoices>
  dispose(): Promise<void>
}
/** A negotiated long-lived receive lifecycle, not an ordinary timed RPC.
 * accept resolves only after durable core acceptance/checkpointing. Opaque event
 * acceptance does not promise replay of volatile platform frames after a crash. */
export interface ChatReceiveSession extends ExtensionChatOperationContext {
  checkpoint(): Promise<ChatCheckpoint>
  accept(delivery: ChatDelivery): Promise<ChatAccepted>
  health(value: ChatReceiveHealth): Promise<void>
  openInteraction(input: ChatInteractionInput): Promise<ChatInteractionContext>
}
/** The host calls `receiveSession` for the provider's declared `receiveModel`. */
export interface ExtensionChatAdapter {
  identify(operation: ExtensionChatOperationContext): Promise<ChatIdentity>
  inspect(chatId: string, operation: ExtensionChatOperationContext): Promise<{ id: string; kind: 'private' | 'group'; eligible: boolean }>
  send(chatId: string, message: ChatMessage, operation: ExtensionChatOperationContext): Promise<ChatReceipt>
  clearButtons(receipt: ChatReceipt, operation: ExtensionChatOperationContext): Promise<void>
  acknowledge(eventId: string, text: string, operation: ExtensionChatOperationContext): Promise<void>
  isMember(chatId: string, userId: string, operation: ExtensionChatOperationContext): Promise<boolean | undefined>
  receiveSession(session: ChatReceiveSession): Promise<void>
  dispose?(): Promise<void>
}

/** Serializable, bounded provider failures; messages must never contain credentials. */
export class ExtensionChatError extends Error {
  readonly failure: ChatFailure
  constructor(failure: ChatFailure) {
    super('Chat transport: ' + failure.kind)
    this.failure = chatFailureSchema.parse(failure)
  }
}
