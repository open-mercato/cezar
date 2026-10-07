import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * The WORKFLOWS family: the chain catalog, the save/parse routes, and the planner.
 *
 * This file must NOT import `./runs.ts`: the run record embeds a workflow definition
 * (`RunRecord.workflowDef`), so `runs.ts` imports the two definition schemas below, and a second
 * edge back would be a module cycle — one whose top-level `z.object(…)` calls would hit a TDZ at
 * import time, not a type error. The parallel-variant shapes (`/groups/:groupId/*`), which DO
 * embed the record, live with the run family for the same reason.
 */

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
        /** Exit codes that loop back; omitted or empty means any non-zero one does. */
        retryOn: z.array(z.number().int().positive()).optional(),
      })
      .optional(),
  })
  .refine((s) => Boolean(s.command) !== Boolean(s.prompt ?? s.skill), {
    message: 'a step is either an agent step (prompt/skill) or a check step (command), not both',
  });
export type WorkflowStepDef = z.infer<typeof workflowStepDefSchema>;

/**
 * A `version: 2` graph workflow (spec 2026-09-30-workflow-node-editor): typed nodes joined by
 * edges from a node's output port (`<node>` or `<node>.<port>`) to the next node. Mirrors
 * `src/workflows/graph.ts` exactly; `contract-parity.workflows.test.ts` keeps them in step.
 */
const graphNodeBase = { id: z.string(), name: z.string().optional() };

/** An `if` node's condition — mirrors `conditionSchema` in `src/workflows/graph.ts`. */
const numericOp = z.enum(['>', '>=', '<', '<=', '==']);
export const workflowConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('diff-lines'), op: numericOp, value: z.number() }),
  z.object({ kind: z.literal('diff-files'), op: numericOp, value: z.number() }),
  z.object({ kind: z.literal('paths-changed'), glob: z.string() }),
  z.object({
    kind: z.literal('output'),
    ref: z.string(),
    op: z.enum(['equals', 'not-equals', 'contains', '>', '>=', '<', '<=']),
    value: z.union([z.string(), z.number()]),
  }),
  z.object({ kind: z.literal('branch'), op: z.enum(['equals', 'matches']), value: z.string() }),
]);
export type WorkflowCondition = z.infer<typeof workflowConditionSchema>;
export const workflowGraphNodeSchema = z.discriminatedUnion('type', [
  z.object({ ...graphNodeBase, type: z.literal('start') }),
  z.object({ ...graphNodeBase, type: z.literal('end'), status: z.enum(['success', 'failed']).default('success') }),
  z.object({ ...graphNodeBase, type: z.literal('loop'), max: z.number().int().positive() }),
  z.object({
    ...graphNodeBase,
    type: z.literal('agent'),
    prompt: z.string().optional(),
    skill: z.string().optional(),
    model: z.string().optional(),
    runner: runnerSchema.optional(),
    allowedTools: z.array(z.string()).optional(),
    bashAllowlist: z.array(z.string()).optional(),
    verdicts: z.array(z.string()).optional(),
    session: z.object({ continue: z.string() }).optional(),
    review: z.boolean().optional(),
    budgetUsd: z.number().optional(),
  }),
  z.object({
    ...graphNodeBase,
    type: z.literal('check'),
    command: z.string(),
    retryOn: z.array(z.number().int().positive()).optional(),
  }),
  z.object({ ...graphNodeBase, type: z.literal('gate.human'), message: z.string(), timeoutMs: z.number().optional() }),
  z.object({
    ...graphNodeBase,
    type: z.literal('ask-user'),
    question: z.string(),
    options: z.array(z.string()).optional(),
    timeoutMs: z.number().optional(),
  }),
  z.object({
    ...graphNodeBase,
    type: z.literal('dispatch'),
    prompt: z.string(),
    runner: runnerSchema.optional(),
    model: z.string().optional(),
    budgetUsd: z.number().optional(),
  }),
  z.object({ ...graphNodeBase, type: z.literal('git.commit'), message: z.string() }),
  z.object({ ...graphNodeBase, type: z.literal('github.draft-pr'), title: z.string().optional() }),
  /** `timeoutMs`/`pollMs` carry defaults server-side, so the served shape always has them. */
  z.object({
    ...graphNodeBase,
    type: z.literal('github.wait-ci'),
    timeoutMs: z.number().default(60 * 60_000),
    pollMs: z.number().default(60_000),
  }),
  z.object({ ...graphNodeBase, type: z.literal('github.pr-comment'), body: z.string() }),
  /** `branches` / `wait` are defaulted server-side, so the served shapes always carry them. */
  z.object({ ...graphNodeBase, type: z.literal('fork'), branches: z.number().int().default(3) }),
  z.object({ ...graphNodeBase, type: z.literal('join'), wait: z.enum(['all', 'any']).default('all') }),
  z.object({
    ...graphNodeBase,
    type: z.literal('workflow'),
    workflow: z.string(),
    prompt: z.string().optional(),
    runner: runnerSchema.optional(),
    budgetUsd: z.number().optional(),
  }),
  z.object({ ...graphNodeBase, type: z.literal('if'), condition: workflowConditionSchema }),
  z.object({ ...graphNodeBase, type: z.literal('git.push') }),
  z.object({ ...graphNodeBase, type: z.literal('git.sync-base') }),
  z.object({
    ...graphNodeBase,
    type: z.literal('github.pr-update'),
    ready: z.boolean().optional(),
    addLabels: z.array(z.string()).optional(),
    reviewers: z.array(z.string()).optional(),
  }),
  z.object({ ...graphNodeBase, type: z.literal('github.issue-comment'), issue: z.number().optional(), body: z.string() }),
  z.object({ ...graphNodeBase, type: z.literal('notify.webhook'), url: z.string(), body: z.string().optional() }),
]);
export type WorkflowGraphNode = z.infer<typeof workflowGraphNodeSchema>;

export const workflowGraphSchema = z.object({
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;

/** One catalog entry: the built-in `quick-task`, or a `.ai/cezar/workflows/*.yaml` file. */
export const workflowDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(workflowStepDefSchema),
  /** Present on `version: 2` graph workflows only; `steps` is then derived from its nodes. */
  graph: workflowGraphSchema.optional(),
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
  /** Present when the pasted YAML was a `version: 2` graph. */
  graph: workflowGraphSchema.optional(),
});
export type ParsedWorkflow = z.infer<typeof parsedWorkflowSchema>;

/** `POST /workflows/graph` body: save a `version: 2` graph as `.ai/cezar/workflows/<slug>.yaml`.
 *  Same 201 / 409 (`exists: true`) contract as `POST /workflows`. */
export const saveWorkflowGraphInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2_000, 'must be at most 2000 characters').optional(),
  graph: workflowGraphSchema,
  overwrite: z.boolean().optional(),
});
export type SaveWorkflowGraphInput = z.infer<typeof saveWorkflowGraphInputSchema>;

/** `POST /workflows/validate` body and answer: structural problems of a graph, `[]` when sound.
 *  A body that is not a graph at all is a 400 like every other validator. */
export const validateWorkflowGraphInputSchema = z.object({ graph: workflowGraphSchema });
export type ValidateWorkflowGraphInput = z.infer<typeof validateWorkflowGraphInputSchema>;
export const validateWorkflowGraphResponseSchema = z.object({ issues: z.array(z.string()) });
export type ValidateWorkflowGraphResponse = z.infer<typeof validateWorkflowGraphResponseSchema>;

/** `GET /workflows/nodes` — the editor palette's node catalog. */
export const workflowNodeCatalogResponseSchema = z.object({
  nodes: z.array(
    z.object({
      type: z.enum([
        'start',
        'end',
        'loop',
        'agent',
        'check',
        'gate.human',
        'ask-user',
        'dispatch',
        'git.commit',
        'github.draft-pr',
        'github.wait-ci',
        'github.pr-comment',
        'fork',
        'join',
        'if',
        'workflow',
        'git.push',
        'git.sync-base',
        'github.pr-update',
        'github.issue-comment',
        'notify.webhook',
      ]),
      category: z.enum(['flow', 'agents', 'scripts', 'git']),
      label: z.string(),
      description: z.string(),
      ports: z.array(z.string()),
      outputs: z.array(z.string()),
    }),
  ),
});
export type WorkflowNodeCatalogResponse = z.infer<typeof workflowNodeCatalogResponseSchema>;

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
