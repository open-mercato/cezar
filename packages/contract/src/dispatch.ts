import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * The DISPATCH family of `/api/v1`: a task may dispatch other tasks (spec
 * `.ai/specs/2026-09-10-dispatch.md`). There are no ranks — any run with the capability on may
 * call `POST /runs/:id/dispatch`, usually from inside its own agent through the `cez task` CLI.
 * A dispatched child runs in its own worktree forked off the parent's branch, reports when it
 * settles, and its unspent budget returns to the parent.
 *
 *  - `dispatchSchema` is a RECORD field (`runRecordSchema.dispatch`), persisted by
 *    `packages/cezar/src/runs/store.ts` through this very value;
 *  - `dispatchInputSchema` and `dispatchReportSchema` are request bodies.
 */

/** What a dispatched task is for. `implement` is the default; `review` judges another task's
 *  branch and answers with a verdict. Nothing else — kinds are cheap to add, expensive to trust. */
export const DISPATCH_KINDS = ['implement', 'review'] as const;
export const dispatchKindSchema = z.enum(DISPATCH_KINDS);
export type DispatchKind = z.infer<typeof dispatchKindSchema>;

/** `POST /runs/:id/report` — how a dispatched task reports upward (the `cez task report` CLI). */
export const dispatchReportSchema = z.object({
  status: z.enum(['done', 'partial', 'failed', 'blocked']),
  result: z.string().max(4000),
  evidence: z.array(z.string().max(400)).max(12).default([]),
  confidence: z.number().min(0).max(1).optional(),
  side_effects: z.array(z.string().max(400)).max(12).default([]),
  errors: z.array(z.string().max(400)).max(12).default([]),
  recommended_next_action: z.string().max(1000).optional(),
  /** A REVIEW task's verdict on the branch it reviewed. The parent merges only after `approve`. */
  verdict: z.enum(['approve', 'changes', 'reject']).optional(),
  /** What the ROOT task should know that lies outside this task's order. Forwarded to the root's
   *  inbox at settle. Suggest, never redefine: the objective stays the user's. */
  suggestions: z.array(z.string().max(400)).max(8).default([]),
});
export type DispatchReport = z.infer<typeof dispatchReportSchema>;

/** A report that arrived while its parent had no open session. Persisted on the parent, flushed
 *  into the prompt when the parent's next session opens. */
export const dispatchPendingReportSchema = z.object({
  fromRunId: z.string(),
  title: z.string(),
  report: dispatchReportSchema,
  at: z.string(),
});
export type DispatchPendingReport = z.infer<typeof dispatchPendingReportSchema>;

/** The engine's own ceiling on children in flight per task; a user's `inFlight` may only lower it. */
export const DISPATCH_MAX_IN_FLIGHT = 4;
/** The most subtasks a user may ask a root for through the composer. */
export const DISPATCH_MAX_SUBTASKS = 50;

/**
 * What the USER asked for when starting a task with the composer's Dispatch toggle: this task is
 * the one that fans out, within these limits. Every field optional — the bare toggle is
 * `{}`, and means "split it, engine defaults for everything". Sent on `POST /runs` as
 * `dispatch`, persisted as `dispatch.intent` on the root, read by the prompt (the intent block)
 * and by `dispatch()` (the caps and the child defaults).
 */
export const dispatchIntentSchema = z.strictObject({
  /** Ceiling on children under this ROOT, in total, across the whole tree. */
  maxSubtasks: z.number().int().min(1).max(DISPATCH_MAX_SUBTASKS).optional(),
  /** Ceiling on children in flight per task — lowers the engine's own, never raises it. */
  inFlight: z.number().int().min(1).max(DISPATCH_MAX_IN_FLIGHT).optional(),
  /** Runner for children whose order names none. Absent = the parent's. */
  runner: runnerSchema.optional(),
  /** Model for children whose order names none. Absent = the parent's. */
  model: z.string().max(120).optional(),
  /** Budget in USD for children whose order names none. Absent = the parent's remainder. */
  budgetUsd: z.number().positive().max(10_000).optional(),
});
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;

/**
 * The `dispatch` object on a run record. Present on every run that dispatched or was dispatched;
 * absent on a plain task, which then behaves exactly as it always has.
 */
export const dispatchSchema = z.object({
  /** The tree's root run id (the root names itself). */
  rootRunId: z.string(),
  /** On a ROOT started with the composer's Dispatch toggle: what the user asked for. */
  intent: dispatchIntentSchema.optional(),
  /** Absent on the root; present on every dispatched child. */
  parentRunId: z.string().optional(),
  /** What this task is for. Absent = `implement`. */
  kind: dispatchKindSchema.optional(),
  /** For a `review` task: the run ids or branches it reviews. */
  reviewOf: z.array(z.string().max(120)).max(8).optional(),
  /** This task's spend ceiling in USD, carved out of its parent's. Absent = none of its own. */
  budgetUsd: z.number().nonnegative().optional(),
  /** This task's own report — last one wins. */
  report: dispatchReportSchema.optional(),
  /** Reports from settled children waiting for this task's next session. */
  pendingReports: z.array(dispatchPendingReportSchema).optional(),
  /** ISO-8601 watermark: inbox files newer than this are "new" for the next digest or wake. */
  inboxSeenAt: z.string().optional(),
  /** The question this run is parked on (the Guard), cleared when an answer is delivered. */
  pendingAsk: z
    .object({
      requestId: z.string().optional(),
      questions: z.array(z.string().max(400)).max(4),
      askedAt: z.string(),
    })
    .optional(),
  /** Set at turn end once `costUsd ≥ budgetUsd`: the run parks and stops auto-continuing. */
  overBudget: z.boolean().optional(),
});
export type RunDispatch = z.infer<typeof dispatchSchema>;
export type DispatchPendingAsk = NonNullable<RunDispatch['pendingAsk']>;

/**
 * `POST /runs/:id/dispatch` — the task order for ONE child. `.strict()`: an unknown key here is a
 * brake that did not fire (a misspelled `max_cost` would spawn an uncapped child).
 */
export const dispatchInputSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    objective: z.string().min(1).max(4000),
    kind: dispatchKindSchema.optional(),
    review_of: z.array(z.string().max(120)).max(8).optional(),
    scope: z.string().max(1000).optional(),
    allowed_tools: z.array(z.string().max(80)).max(16).optional(),
    max_cost: z.number().positive().optional(),
    success_criteria: z.string().max(1000).optional(),
    required_evidence: z.string().max(1000).optional(),
    retry_limit: z.number().int().min(0).max(3).optional(),
    /** The child's backend and model. Absent = the parent's. */
    runner: runnerSchema.optional(),
    model: z.string().max(200).optional(),
  })
  .strict();
export type DispatchInput = z.infer<typeof dispatchInputSchema>;

/** `POST /runs/:id/dispatch` → the child's id and branch (the branch is what the parent merges). */
export const dispatchResponseSchema = z.object({
  id: z.string(),
  branch: z.string().optional(),
});
export type DispatchResponse = z.infer<typeof dispatchResponseSchema>;
