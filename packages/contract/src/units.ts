import { z } from 'zod';
// The runner enum lives with the health family (it is what `defaultRunner` answers with), so the
// ladder consumes it rather than redeclaring a fourth spelling of the same four backends.
import { runnerSchema } from './health.ts';

/**
 * The UNITS family of `/api/v1` (spec `.ai/specs/2026-09-08-units-hierarchy.md`) — the
 * hierarchical army of runs: **Caesar → Legate → Centurion**, with legionaries being the
 * centurion's own backend sub-agents rather than runs of their own.
 *
 * Three kinds of shape live here and they are deliberately not the same kind of thing:
 *
 *  - `unitSchema` is a RECORD field. It rides on `runRecordSchema` (`./runs.ts`) and has a
 *    persistence twin in `packages/cezar/src/runs/store.ts`, which imports this very value so
 *    the two cannot drift — `src/server/contract-parity.runs.test.ts` proves it in both
 *    directions;
 *  - `unitSpawnSchema` / `unitReportSchema` are MARKER payloads. They never come off the wire:
 *    they are parsed out of an agent's own turn text (`CEZ:SPAWN <json>` / `CEZ:REPORT <json>`)
 *    by `src/units/markers.ts`, the way `CEZ:ASK` is parsed by `src/core/ask.ts`. They are
 *    `.strict()` where an unknown key means the agent invented a field, because a silently
 *    dropped `max_cost` is a budget brake that did not fire;
 *  - `startMissionInputSchema` and the prompt shapes are ORDINARY request/response bodies for the
 *    gated `/missions` and `/units/prompts*` routes.
 *
 * Every bound here is the server's own, so a client that validates before sending gets the same
 * answer the route would give (#429).
 */

// ---- roles and the per-role ladder ----------------------------------------------------------

/**
 * The three roles that are REAL RUNS (spec Q2). `legionary` is deliberately absent: it is the
 * centurion's native sub-agent (claude's `Task` tool), not a cezar run — and `legate` stays even
 * though the MVP's two sizes never place one, because the ladder, the prompts and the enum are
 * where a Legion would slot in without a migration (Q8).
 */
export const UNIT_ROLES = ['caesar', 'legate', 'centurion'] as const;
export const unitRoleSchema = z.enum(UNIT_ROLES);
export type UnitRole = z.infer<typeof unitRoleSchema>;

/** One rung of the mission ladder: which backend and model a role's runs are dispatched to.
 *  Both optional — an omitted rung falls back to the project's own defaults, the same way
 *  `POST /runs` falls back when the composer names neither. */
export const unitLadderEntrySchema = z.object({
  runner: runnerSchema.optional(),
  model: z.string().optional(),
});
export type UnitLadderEntry = z.infer<typeof unitLadderEntrySchema>;

/** The mission's per-role runner+model choices, chosen once in the composer and read by every
 *  spawn below it. Partial: naming a role is opt-in, naming none is the zero-config mission. */
export const unitLadderSchema = z
  .object({
    caesar: unitLadderEntrySchema,
    legate: unitLadderEntrySchema,
    centurion: unitLadderEntrySchema,
  })
  .partial();
export type UnitLadder = z.infer<typeof unitLadderSchema>;

// ---- the marker payloads ---------------------------------------------------------------------

/**
 * `CEZ:REPORT <json>` — how a unit run reports upward.
 *
 * The three arrays carry `.default([])` rather than `.optional()`: a report is read by a PARENT
 * agent as prose, and "no evidence" and "the model omitted the key" are the same thing to a
 * reader — filling them on parse means the renderer never branches.
 *
 * Deliberately NOT `.strict()`, unlike the spawn payload below. A report is a statement about
 * work already done, so an unknown key costs nothing but noise and is stripped; a spawn is an
 * INSTRUCTION whose optional keys are cost and scope brakes, and dropping a misspelled one
 * silently would let a child run uncapped. The asymmetry is the point.
 */
export const unitReportSchema = z.object({
  status: z.enum(['done', 'partial', 'failed', 'blocked']),
  result: z.string().max(4000),
  evidence: z.array(z.string().max(400)).max(12).default([]),
  confidence: z.number().min(0).max(1).optional(),
  side_effects: z.array(z.string().max(400)).max(12).default([]),
  errors: z.array(z.string().max(400)).max(12).default([]),
  recommended_next_action: z.string().max(1000).optional(),
});
export type UnitReport = z.infer<typeof unitReportSchema>;

/** A report that arrived while its parent had no open session (spec Q7). Persisted on the parent
 *  so a restart cannot lose it; flushed into the prompt when the parent's next session opens. */
export const unitPendingReportSchema = z.object({
  fromRunId: z.string(),
  title: z.string(),
  report: unitReportSchema,
  /** ISO-8601 instant the report settled. */
  at: z.string(),
});
export type UnitPendingReport = z.infer<typeof unitPendingReportSchema>;

/**
 * The `unit` object on a run record. Absent = today's flat behaviour, which is what makes the
 * whole feature additive: a cezar that has never heard of units parses every record unchanged.
 */
export const unitSchema = z.object({
  role: unitRoleSchema,
  /** The ROOT run's id — the mission every node in the tree groups under. On the root itself this
   *  is its own id, which is why the route writes `unit` immediately after creation. */
  missionId: z.string(),
  /** Absent on the root; present on every spawned child. */
  parentRunId: z.string().optional(),
  /** This node's spend ceiling in USD. Absent = no ceiling of its own (the parent's still binds). */
  budgetUsd: z.number().nonnegative().optional(),
  ladder: unitLadderSchema.optional(),
  /** This run's own `CEZ:REPORT` — last one wins, so a run that reports twice reports its latest. */
  report: unitReportSchema.optional(),
  /** Reports from settled children waiting for this run's next session (Q7). */
  pendingReports: z.array(unitPendingReportSchema).optional(),
  /** Set at turn end once `costUsd ≥ budgetUsd`: the run parks and stops auto-continuing (Q6). */
  overBudget: z.boolean().optional(),
});
export type RunUnit = z.infer<typeof unitSchema>;

/**
 * `CEZ:SPAWN <json>` — how a unit run delegates one role downward.
 *
 * `.strict()`, and the whole payload is refused rather than trimmed when a key is unknown: the
 * optional keys here are the TASK ORDER (scope, allowed tools, cost cap, success criteria), and
 * silently dropping a misspelled `max_costs` would spawn a child with no cost ceiling at all. A
 * refused payload is a transcript note, never a crash.
 */
export const unitSpawnSchema = z
  .object({
    children: z
      .array(
        z
          .object({
            title: z.string().min(1).max(120),
            objective: z.string().min(1).max(4000),
            scope: z.string().max(1000).optional(),
            allowed_tools: z.array(z.string()).max(16).optional(),
            max_cost: z.number().positive().optional(),
            success_criteria: z.string().max(1000).optional(),
            required_evidence: z.string().max(1000).optional(),
            retry_limit: z.number().int().min(0).max(3).optional(),
          })
          .strict(),
      )
      .min(1)
      /** Four in flight per parent (spec Q2): `maxParallel` defaults to 2 and only two monitors
       *  are slot-exempt, so a wider fan-out starves its own tree. */
      .max(4),
  })
  .strict();
export type UnitSpawn = z.infer<typeof unitSpawnSchema>;
export type UnitSpawnChild = UnitSpawn['children'][number];

// ---- the mission routes -----------------------------------------------------------------------

/**
 * The three tree shapes a mission can take (spec Q8).
 *
 *  - `legionary` — a plain task, unchanged: `POST /missions` starts it with no `unit` at all;
 *  - `squad`     — a Centurion that dispatches legionaries as its backend's own sub-agents;
 *  - `army`      — a Caesar that spawns Legates, which spawn Centurions.
 *
 * Legion is cut for the MVP; `legate` stays in `UNIT_ROLES` because it is a rung of the army.
 */
export const unitSizeSchema = z.enum(['legionary', 'squad', 'army']);
export type UnitSize = z.infer<typeof unitSizeSchema>;

/** `POST /api/v1/p/:projectId/missions`. Bounds mirror `createRunInputBaseSchema.task`. */
export const startMissionInputSchema = z.object({
  objective: z.string().min(1).max(100_000, 'must be at most 100000 characters'),
  unit: unitSizeSchema,
  /** Mission-wide spend ceiling in USD, inherited downward as each child's budget is carved
   *  out of it. Absent = uncapped, which is the pre-existing behaviour of every cezar run. */
  budgetUsd: z.number().nonnegative().optional(),
  ladder: unitLadderSchema.optional(),
  /** Standing rules appended to the objective as a `## Constraints` block. */
  constraints: z.array(z.string().max(400)).max(20).optional(),
});
export type StartMissionInput = z.input<typeof startMissionInputSchema>;

/** The mission's root run id — the thread the composer navigates to, and the `unit.missionId`
 *  every node in the tree carries. Deliberately just the id: the cockpit already has the run
 *  record from its own `useRuns()` cache a moment later. */
export const startMissionResponseSchema = z.object({ id: z.string() });
export type StartMissionResponse = z.infer<typeof startMissionResponseSchema>;

// ---- the role prompts --------------------------------------------------------------------------

/** One role's effective system prompt. `source` is what the Settings editor renders as the
 *  `edited` / `default` badge — and what tells a DELETE it has something to restore. */
export const unitPromptSchema = z.object({
  role: unitRoleSchema,
  text: z.string(),
  source: z.enum(['default', 'file']),
});
export type UnitPrompt = z.infer<typeof unitPromptSchema>;

/** `GET /api/v1/p/:projectId/units/prompts` — one entry per role, always all three. */
export const unitPromptsResponseSchema = z.object({
  prompts: z.array(unitPromptSchema),
});
export type UnitPromptsResponse = z.infer<typeof unitPromptsResponseSchema>;

/** `PUT …/units/prompts/:role`. Bounded like every other prompt field on this API (#429) — a
 *  role prompt is composed into a spawned process's system prompt, so it is never unbounded. */
export const unitPromptInputSchema = z.object({
  text: z.string().min(1).max(40_000, 'must be at most 40000 characters'),
});
export type UnitPromptInput = z.infer<typeof unitPromptInputSchema>;
