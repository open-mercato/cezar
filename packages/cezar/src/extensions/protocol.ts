// Host <-> worker IPC frames (worker side: extension-worker.ts). Internal to the service: neither the
// public SDK nor the HTTP contract exports these, so the protocol can change with the host.
import { z } from 'zod'
import { chatFailureSchema, extensionRunIdSchema } from '@open-mercato/cezar-contract'

export const extensionRpcResponseSchema = z.object({
  type: z.literal('response'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), failure: chatFailureSchema.optional() }).optional(),
}).strict()

export const extensionHostRequestSchema = z.object({
  type: z.literal('hostRequest'), requestId: z.string().min(1).max(100), generation: z.string().min(1).max(100),
  method: z.enum(['tasks.list', 'tasks.get', 'tasks.propose', 'storage.get', 'storage.set', 'secrets.get', 'secrets.set', 'logger.info', 'logger.error', 'chat.assertActive', 'chat.service']),
  params: z.unknown(), invocationId: z.string().uuid().optional(),
}).strict()
export type ExtensionHostRequest = z.infer<typeof extensionHostRequestSchema>
export const extensionStorageKeySchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
export const extensionStorageGetSchema = z.object({ key: extensionStorageKeySchema }).strict()
export const extensionStorageSetSchema = extensionStorageGetSchema.extend({ value: z.json() }).strict()
export const extensionSecretSetSchema = extensionStorageGetSchema.extend({ value: z.string().min(1).max(32768) }).strict()
export const extensionLogInputSchema = z.object({ message: z.string().max(4000) }).strict()
export const extensionEmptyInputSchema = z.object({}).strict()
/** worker→host `tasks.get` params. */
export const extensionTaskGetSchema = z.object({ runId: extensionRunIdSchema }).strict()
/** host→worker `panel` / `invoke` params (the host-asserted `runId` is sent only for `task`-located
 *  contributions; the worker never receives one for any other location). */
export const extensionPanelCallSchema = z.object({ panelId: z.string().min(1).max(100), runId: extensionRunIdSchema.optional() }).strict()
export const extensionInvokeCallSchema = z.object({
  actionId: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()).optional(),
  invocationId: z.string().uuid().optional(), runId: extensionRunIdSchema.optional(),
}).strict()

export const extensionChatCallSchema = z.object({
  providerId: z.string().min(1).max(64), botHandle: z.string().uuid(), credentialProfile: z.literal('slack-oauth-v1').optional(), credential: z.string().max(32768),
  operation: z.enum(['identify', 'inspect', 'send', 'clearButtons', 'acknowledge', 'isMember', 'receiveSession', 'retire']),
  input: z.unknown(),
}).strict()
