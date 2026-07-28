import { z } from 'zod';
// The run shapes belong to the runs family; this file consumes them rather than redeclaring.
import { queuedMessageSchema, runRecordSchema, runStatusSchema, stepStateSchema } from './runs.ts';
export type { QueuedMessage, RunRecord, RunStatus, StepState } from './runs.ts';
import { runnerSchema } from './health.ts';

// ---- TEMPORARY: the run-record shapes this family embeds ---------------------------------
//
// `PickVariantResponse` (`POST /groups/:groupId/pick`) and `StartTodoResponse`
// (`POST /todos/:id/start`, see `./skills.ts`) both answer with a whole stored run, so this
// family cannot be described without the run record. The run family is a SEPARATE slice of the
// contract, so the four schemas below are a verbatim mirror of `src/runs/store.ts` and exist
// only so the group/inbox schemas can be written — and PROVEN — before the run slice lands.
//
// AT MERGE: delete this block and import `runStatusSchema` / `runRecordSchema` from the run
// contract module instead. Nothing else in this file changes.

// ---- workflows (`GET/POST /workflows`, `DELETE /workflows/:name`, `POST /workflows/parse`) ----

/**
 * One step of a chain: either an agent step (`prompt`/`skill`) or a check step (`command`).
 *
 * `onFail.max` carries a `.default(2)`, exactly as `src/workflows/types.ts` declares it, so the
 * OUTPUT shape the routes serve has `max` present whenever `onFail` is.
 */
export const workflowStepDefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    // agent step
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    /** Per-step agent backend override (falls back to the task / config default). */
    runner: runnerSchema.optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    // check step
    command: z.string().optional(),
    onFail: z
      .object({
        retry: z.string().min(1),
        max: z.number().int().positive().default(2),
      })
      .optional(),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.prompt ?? s.skill), {
    message: 'a step is either an agent step (prompt/skill) or a check step (command), not both',
  });
export type WorkflowStepDef = z.infer<typeof workflowStepDefSchema>;

/** One catalog entry: the built-in `quick-task`, or a `.ai/cezar/workflows/*.yaml` file. */
export const workflowDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
  source: z.enum(['built-in', 'file']),
  /** Absent on built-ins — which is exactly what makes them undeletable. */
  path: z.string().optional(),
});
export type WorkflowDef = z.infer<typeof workflowDefSchema>;

/** A workflow file that failed to load. Reported, never fatal — the catalog still answers. */
export const workflowLoadIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type WorkflowLoadIssue = z.infer<typeof workflowLoadIssueSchema>;

/** `GET /workflows` — the catalog plus the files that could not be read. */
export const workflowsResponseSchema = z.object({
  workflows: z.array(workflowDefSchema),
  issues: z.array(workflowLoadIssueSchema),
});
export type WorkflowsResponse = z.infer<typeof workflowsResponseSchema>;

/**
 * `POST /workflows` body: save a chain as `.ai/cezar/workflows/<slug>.yaml`.
 *
 * Exactly one of `steps` / the portable `skills` shorthand — the refinement below is the same
 * XOR the server enforces. Without `overwrite` an existing file answers 409 (`exists: true`).
 */
export const saveWorkflowInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().max(2_000, 'must be at most 2000 characters').optional(),
    steps: z.array(workflowStepDefSchema).min(1).max(8).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.steps) !== Boolean(b.skills), {
    message: 'provide either "steps" or "skills", not both',
  });
export type SaveWorkflowInput = z.infer<typeof saveWorkflowInputSchema>;

/** `POST /workflows` — 201 with where the YAML landed. */
export const saveWorkflowResponseSchema = z.object({
  path: z.string(),
  name: z.string(),
});
export type SaveWorkflowResponse = z.infer<typeof saveWorkflowResponseSchema>;

/** `POST /workflows/parse` (spec 012) — pasted YAML, normalized to plain steps. */
export const parsedWorkflowSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
});
export type ParsedWorkflow = z.infer<typeof parsedWorkflowSchema>;

/**
 * `DELETE /workflows/:name` — file workflows only; built-ins answer 400.
 *
 * `ok` is the LITERAL `true`, not a boolean: the only body carrying it is the success one, and
 * every failure is an `{ error }` status instead. The hand-written DTO said `boolean`, which
 * was wider than the route has ever been.
 */
export const deleteWorkflowResponseSchema = z.object({
  ok: z.literal(true),
  path: z.string(),
});
export type DeleteWorkflowResponse = z.infer<typeof deleteWorkflowResponseSchema>;

// ---- plan (`POST /plan`, spec 008) -------------------------------------------------------

/**
 * The proposed chain for a task. Never a hard failure: a missing CLI, a timeout or an
 * unparseable answer degrade to the one-step quick-task plan with `fallback: true`.
 */
export const planResponseSchema = z.object({
  /** The kebab-case workflow title the planner proposed. Absent on the degraded fallback. */
  name: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
  rationale: z.string(),
  fallback: z.boolean(),
});
export type PlanResponse = z.infer<typeof planResponseSchema>;

// ---- parallel variants (spec 010) --------------------------------------------------------

/**
 * One variant column of the compare view.
 *
 * CAREFUL: `diffStat` here is the raw `git diff --stat` TEXT the server runs in the variant's
 * worktree — a different thing from the numeric `RunRecord.diffStat`. `''` when the worktree
 * is gone.
 */
export const groupVariantSchema = z.object({
  id: z.string(),
  /** 'A' | 'B' | 'C' in practice; `'?'` for a record that lost its letter. */
  variant: z.string(),
  title: z.string(),
  status: runStatusSchema,
  archived: z.boolean(),
  tokensUsed: z.number(),
  costUsd: z.number().optional(),
  diffStat: z.string(),
  /** First lines of the handoff journal's "## Progress log" section, as markdown. */
  handoffExcerpt: z.string(),
});
export type GroupVariant = z.infer<typeof groupVariantSchema>;

/** `GET /groups/:groupId` — every run sharing a groupId, side by side. */
export const groupResponseSchema = z.object({
  groupId: z.string(),
  runs: z.array(groupVariantSchema),
});
export type GroupResponse = z.infer<typeof groupResponseSchema>;

/**
 * `POST /groups/:groupId/pick` — the winner (parked at `review` when it has a diff); the losers
 * were cancelled if alive, archived, and their worktrees + branches removed.
 *
 * `winner` is OPTIONAL because that is what the wire says: the handler builds
 * `{ winner: store.getRun(id) }`, and `JSON.stringify` drops the key entirely when the lookup
 * misses. See `contract-parity.workflows.test.ts` — the route's own type still claims a
 * required `winner: RunRecord | undefined`, which is a handler defect, not a contract one.
 */
export const pickVariantResponseSchema = z.object({
  winner: runRecordSchema.optional(),
});
export type PickVariantResponse = z.infer<typeof pickVariantResponseSchema>;
