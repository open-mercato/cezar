import { z } from 'zod';

/** Server-derived execution identity. Paths are never accepted from an HTTP caller. */
export const deferredBindingSchema = z.object({
  revision: z.string(),
  runner: z.string(),
  models: z.array(z.object({ runner: z.string(), model: z.string().optional(), step: z.string().optional() })).optional(),
  accounts: z.array(z.object({ runner: z.string(), id: z.string(), path: z.string(), identity: z.string().optional() })),
});
export type DeferredBinding = z.infer<typeof deferredBindingSchema>;
export const deferredStartStateSchema = z.object({
  origin: z.literal('composer'),
  reason: z.enum(['at', 'usage-reset']),
  notBefore: z.string().datetime(),
  timeZone: z.string(),
  binding: deferredBindingSchema,
  creationKey: z.string(),
  requestDigest: z.string(),
  status: z.enum(['pending', 'launching', 'failed', 'missed']),
  error: z.string().optional(),
  failureKind: z.enum(['binding-invalid', 'transient', 'ambiguous']).optional(),
  holdUntil: z.string().datetime().optional(),
  manualRequested: z.boolean().optional(),
  runIds: z.array(z.string()).default([]),
});
export type DeferredStartState = z.infer<typeof deferredStartStateSchema>;
export const deferredCreationRecordSchema = z.object({
  id: z.string(), requestDigest: z.string(),
  outcome: z.enum(['pending', 'launched', 'cancelled']),
  runIds: z.array(z.string()),
});
export type DeferredCreationRecord = z.infer<typeof deferredCreationRecordSchema>;

export const queueWaitReasonSchema = z.discriminatedUnion('kind', [
  // `account` (`runner:profileId`) is what "Resume now" lifts; absent on records from before it.
  z.object({ kind: z.literal('usage-reset'), until: z.string().datetime(), timeZone: z.string().optional(), account: z.string().min(1).optional() }),
  z.object({ kind: z.literal('account-resume') }),
  /** Every account a manager may route this task to already runs as many tasks as it allows. */
  z.object({ kind: z.literal('account-busy') }),
]);
export type QueueWaitReason = z.infer<typeof queueWaitReasonSchema>;
