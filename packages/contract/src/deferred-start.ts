import { z } from 'zod';
import { createRunInputSchema } from './runs.ts';
import { deferredCreationRecordSchema } from './deferred-start-state.ts';

export const startConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('usage-reset') }),
]);
export type StartCondition = z.infer<typeof startConditionSchema>;
export const deferredPreviewInputSchema = z.object({ task: createRunInputSchema, start: startConditionSchema });
export type DeferredPreviewInput = z.input<typeof deferredPreviewInputSchema>;
export const deferredCreateInputSchema = deferredPreviewInputSchema.extend({ previewRevision: z.string().min(1).max(128), idempotencyKey: z.string().uuid() });
export type DeferredCreateInput = z.input<typeof deferredCreateInputSchema>;
export const deferredPreviewSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), notBefore: z.string().datetime(), timeZone: z.string(), previewRevision: z.string(), observation: z.string().optional() }),
  z.object({ available: z.literal(false), reason: z.string(), message: z.string() }),
]);
export type DeferredPreview = z.infer<typeof deferredPreviewSchema>;
export const deferredCreateResponseSchema = z.object({ scheduled: deferredCreationRecordSchema });
export const deferredMutationQuerySchema = z.object({ expectedRevision: z.coerce.number().int().positive().optional() });

/** Cancellation lost a race to a completed launch; links remain available from the ledger. */
export const deferredAlreadyStartedSchema = z.object({ error: z.string(), runIds: z.array(z.string()) });
export type DeferredAlreadyStarted = z.infer<typeof deferredAlreadyStartedSchema>;
export const deferredCancellationConflictSchema = deferredAlreadyStartedSchema.partial({ runIds: true });

/** Local metadata only: no provider probe or usage lookup. */
export const deferredOptionsInputSchema = z.object({ task: createRunInputSchema });
export type DeferredOptionsInput = z.input<typeof deferredOptionsInputSchema>;
export const deferredOptionsSchema = z.object({
  timeZone: z.string(),
  usageReset: z.discriminatedUnion('available', [
    z.object({ available: z.literal(true), provider: z.enum(['claude', 'codex']) }),
    z.object({ available: z.literal(false), reason: z.string(), message: z.string() }),
  ]),
});
export type DeferredOptions = z.infer<typeof deferredOptionsSchema>;
