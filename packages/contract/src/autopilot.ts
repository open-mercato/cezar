import { z } from 'zod';
import { processUsageSchema } from './runs.ts';

/**
 * Autopilot — Self-Heal Loop + Control Tower (spec `.ai/specs/2026-09-19-autopilot-heal-tower.md`).
 *
 * Workspace-level telemetry / governor and per-project heal-cycle ledgers. Additive; gated by
 * `capabilities.autopilot` (`CEZ_AUTOPILOT=0` turns the feature off).
 */

/** Governor knobs. Every limit is nullable: `null` = no enforcement (zero-config safe). */
export const autopilotGovernorSchema = z.object({
  /** Rolling spend ceiling across all projects, USD per hour. */
  maxSpendUsdPerHour: z.number().min(0).max(10_000).nullable(),
  /** Sum of live RSS across every running process tree, MiB. */
  maxRssMbTotal: z.number().int().min(0).max(1_048_576).nullable(),
  /** Pause a running task whose last activity is older than this many minutes. */
  stuckAfterMinutes: z.number().int().min(1).max(240).nullable(),
  /**
   * When spend is over the hourly cap, temporarily treat `maxParallel` as this value (1–16).
   * `null` = do not soft-cap; only pause/recommend.
   */
  softMaxParallel: z.number().int().min(1).max(16).nullable(),
});
export type AutopilotGovernor = z.infer<typeof autopilotGovernorSchema>;

export const defaultAutopilotGovernor = (): AutopilotGovernor => ({
  maxSpendUsdPerHour: null,
  maxRssMbTotal: null,
  stuckAfterMinutes: null,
  softMaxParallel: null,
});

export const setAutopilotGovernorInputSchema = autopilotGovernorSchema.partial();
export type SetAutopilotGovernorInput = z.infer<typeof setAutopilotGovernorInputSchema>;

export const towerRunRowSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  runId: z.string(),
  title: z.string(),
  status: z.string(),
  costUsd: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  usage: processUsageSchema.optional(),
  ageMinutes: z.number(),
  stuck: z.boolean(),
});
export type TowerRunRow = z.infer<typeof towerRunRowSchema>;

export const towerActionSchema = z.object({
  kind: z.enum(['pause', 'soft-cap', 'warn']),
  runId: z.string().optional(),
  projectId: z.string().optional(),
  reason: z.string(),
  applied: z.boolean(),
});
export type TowerAction = z.infer<typeof towerActionSchema>;

export const towerForecastSchema = z.object({
  /** Extra parallel slots the operator is considering. */
  extraParallel: z.number().int().min(0).max(16),
  projectedUsdPerHour: z.number().nullable(),
  projectedRssMb: z.number().nullable(),
  wouldExceedSpend: z.boolean(),
  wouldExceedRss: z.boolean(),
});
export type TowerForecast = z.infer<typeof towerForecastSchema>;

/** `GET /api/v1/workspace/autopilot/tower` */
export const towerSnapshotSchema = z.object({
  at: z.string(),
  governor: autopilotGovernorSchema,
  running: z.number().int().min(0),
  queued: z.number().int().min(0),
  spendUsdLastHour: z.number(),
  spendUsdPerHour: z.number(),
  totalRssMb: z.number(),
  maxParallel: z.number().int(),
  effectiveMaxParallel: z.number().int(),
  runs: z.array(towerRunRowSchema),
  actions: z.array(towerActionSchema),
  forecast: towerForecastSchema,
});
export type TowerSnapshot = z.infer<typeof towerSnapshotSchema>;

export const healCandidateSchema = z.object({
  runId: z.string().optional(),
  title: z.string(),
  objective: z.string(),
  source: z.enum(['issue', 'test', 'manual', 'scout']),
  sourceRef: z.string().optional(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'review', 'picked', 'discarded']),
  checkExitCode: z.number().int().optional(),
  checkOutput: z.string().max(20_000).optional(),
  costUsd: z.number().optional(),
  verdict: z.enum(['approve', 'reject', 'inconclusive']).optional(),
  score: z.number().optional(),
});
export type HealCandidate = z.infer<typeof healCandidateSchema>;

export const healCycleSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(['scouting', 'spawning', 'verifying', 'reviewing', 'proposing', 'done', 'failed', 'cancelled']),
  brief: z.string(),
  successCriteria: z.string().optional(),
  budgetUsd: z.number().optional(),
  maxCandidates: z.number().int().min(1).max(32),
  rootRunId: z.string().optional(),
  candidates: z.array(healCandidateSchema),
  winnerRunId: z.string().optional(),
  draftPrUrl: z.string().optional(),
  notes: z.string().optional(),
});
export type HealCycle = z.infer<typeof healCycleSchema>;

export const createHealCycleInputSchema = z.object({
  brief: z.string().trim().min(1).max(20_000),
  successCriteria: z.string().trim().max(4_000).optional(),
  budgetUsd: z.number().min(0).max(1_000).optional(),
  maxCandidates: z.number().int().min(1).max(32).optional(),
  rootRunId: z.string().trim().min(1).max(128).optional(),
});
export type CreateHealCycleInput = z.infer<typeof createHealCycleInputSchema>;

export const patchHealCycleInputSchema = z
  .object({
    status: healCycleSchema.shape.status.optional(),
    candidates: z.array(healCandidateSchema).optional(),
    winnerRunId: z.string().nullable().optional(),
    draftPrUrl: z.string().nullable().optional(),
    notes: z.string().max(20_000).nullable().optional(),
    successCriteria: z.string().max(4_000).nullable().optional(),
  })
  .strict();
export type PatchHealCycleInput = z.infer<typeof patchHealCycleInputSchema>;

export const healCyclesListSchema = z.object({
  cycles: z.array(healCycleSchema),
});
export type HealCyclesList = z.infer<typeof healCyclesListSchema>;

export const evaluateTowerInputSchema = z.object({
  /** When true, apply pause / soft-cap actions; otherwise return recommendations only. */
  apply: z.boolean().optional(),
  /** What-if extra parallel for the forecast strip. */
  extraParallel: z.number().int().min(0).max(16).optional(),
});
export type EvaluateTowerInput = z.infer<typeof evaluateTowerInputSchema>;
