import { z } from 'zod';
import { runnerSchema } from './health.ts';
import { dispatchReportSchema } from './dispatch.ts';

/**
 * The WAITS family of `/api/v1` (spec `.ai/specs/2026-10-05-cross-task-waits.md`): a running task
 * waits for another task — by run id, in its own or another registered project — and is woken by
 * the engine when that task settles. Two routes, both project-scoped and mounted under the
 * waiter's project:
 *
 *  - `POST /runs/:id/waits` — declare a wait (or, Phase 2, create a task in another project and
 *    wait for it in the same request);
 *  - `DELETE /runs/:id/waits/:waitId` — stop waiting ("Stop waiting" in the cockpit).
 *
 * The edges themselves ride on the waiter's run record (`RunRecord.waits`), so every existing run
 * payload already carries them — there is no GET route.
 *
 * One-way import direction, like `./dispatch.ts`: `./runs.ts` embeds these shapes in the record, so
 * this file must not import from it. That is why `waitRunStatusSchema` restates the seven run
 * statuses; `contract-parity.waits.test.ts` pins it to `runStatusSchema`.
 */

/** The seven run statuses, restated (see the header) — pinned to `runStatusSchema` by a test. */
export const waitRunStatusSchema = z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']);

/** At most this many PENDING edges per waiter — the dispatch in-flight cap's twin. */
export const WAIT_MAX_PENDING = 4;
/** Resolved edges kept on the record for the timeline; older ones are trimmed. */
export const WAIT_MAX_HISTORY = 20;
/** The deadline every edge carries when the declaration names none: 24 h. */
export const WAIT_DEFAULT_TIMEOUT_MINUTES = 24 * 60;
/** The longest deadline a declaration may ask for: 7 days. */
export const WAIT_MAX_TIMEOUT_MINUTES = 7 * 24 * 60;

/** Every state an edge can be in. Only `pending` holds the waiter parked. */
export const WAIT_STATES = [
  'pending',
  'settled',
  'target-deleted',
  'target-unavailable',
  'timed-out',
  'cancelled',
  'waiter-ended',
] as const;
export const waitStateSchema = z.enum(WAIT_STATES);
export type WaitState = z.infer<typeof waitStateSchema>;

/** Who declared an edge. Derived by the route, never read from a request body. */
export const waitOriginSchema = z.enum(['agent', 'user']);
export type WaitOrigin = z.infer<typeof waitOriginSchema>;

/** A run in some registered project — always the FULL run id, resolved at declare time. */
export const waitTargetRefSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
});
export type WaitTargetRef = z.infer<typeof waitTargetRefSchema>;

/** The target's state when the edge resolved, as persisted on the edge. */
export const waitEdgeOutcomeSchema = z.object({
  status: waitRunStatusSchema,
  prUrl: z.string().optional(),
  costUsd: z.number().optional(),
});
export type WaitEdgeOutcome = z.infer<typeof waitEdgeOutcomeSchema>;

/** One wait edge on the WAITER's record. */
export const waitEdgeSchema = z.object({
  id: z.string(),
  target: waitTargetRefSchema,
  /** Snapshot for the UI when the target's project is not built or has been removed. */
  targetTitle: z.string(),
  origin: waitOriginSchema,
  /** True when the same request also created the target (Phase 2, `cez task create --project`). */
  created: z.boolean().optional(),
  /** What a created target was given to spend (Phase 2) — what the creator's budget reserves
   *  while the edge is pending. */
  budgetUsd: z.number().nonnegative().optional(),
  createdAt: z.string(),
  deadline: z.string(),
  state: waitStateSchema,
  resolvedAt: z.string().optional(),
  outcome: waitEdgeOutcomeSchema.optional(),
});
export type WaitEdge = z.infer<typeof waitEdgeSchema>;

/** On a target created by another task's wait (Phase 2): who created it. */
export const waitedBySchema = waitTargetRefSchema;
export type WaitedBy = z.infer<typeof waitedBySchema>;

const timeoutMinutesSchema = z.number().int().min(1).max(WAIT_MAX_TIMEOUT_MINUTES);

/** The `target` branch: wait for a task that already exists. An omitted `projectId` is the
 *  waiter's own project; `default` is the boot project, as everywhere in `/api/v1/p/:projectId`.
 *  `runId` may be the full id or its first eight characters. */
export const waitTargetInputSchema = z.strictObject({
  target: z.strictObject({
    projectId: z.string().min(1).max(200).optional(),
    runId: z.string().min(1).max(200),
  }),
  timeoutMinutes: timeoutMinutesSchema.optional(),
});

/** The `create` branch (Phase 2): start an independent, autonomous task in another project and
 *  wait for it. `.strict()` for the reason `dispatchInputSchema` is: a misspelled `budget` is a
 *  brake that did not fire. */
export const waitCreateInputSchema = z.strictObject({
  create: z.strictObject({
    projectId: z.string().min(1).max(200),
    objective: z.string().min(1).max(4000),
    title: z.string().min(1).max(120).optional(),
    budget: z.number().positive().max(10_000).optional(),
    runner: runnerSchema.optional(),
    model: z.string().max(200).optional(),
    scope: z.string().max(1000).optional(),
    success: z.string().max(1000).optional(),
  }),
  timeoutMinutes: timeoutMinutesSchema.optional(),
});

/** `POST /runs/:id/waits` body — `target` XOR `create`. */
export const waitInputSchema = z.union([waitTargetInputSchema, waitCreateInputSchema]);
export type WaitInput = z.infer<typeof waitInputSchema>;

/** A settled target, as the route answers it when nothing needed recording. */
export const waitOutcomeSchema = z.object({
  target: waitTargetRefSchema,
  title: z.string(),
  status: waitRunStatusSchema,
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  costUsd: z.number().optional(),
  error: z.string().optional(),
  /** The target's own `cez task report`, when it filed one. */
  report: dispatchReportSchema.optional(),
});
export type WaitOutcome = z.infer<typeof waitOutcomeSchema>;

/** `POST /runs/:id/waits` → an edge was recorded, or the target had already settled. */
export const waitDeclareResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending'), edge: waitEdgeSchema }),
  z.object({ kind: z.literal('settled'), outcome: waitOutcomeSchema }),
]);
export type WaitDeclareResponse = z.infer<typeof waitDeclareResponseSchema>;

/** `DELETE /runs/:id/waits/:waitId` → the edge, now `cancelled`. */
export const waitCancelResponseSchema = z.object({ edge: waitEdgeSchema });
export type WaitCancelResponse = z.infer<typeof waitCancelResponseSchema>;
