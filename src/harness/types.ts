import { z } from 'zod';

/**
 * The harness ledger — the conductor's durable memory for a multi-model
 * harness run (spec 2026-07-23-harness-orchestration, Data Model).
 *
 * Ownership rules the shape encodes:
 *  - cezar owns control flow: phases, loop counters, decisions;
 *  - the vendored cez-* skills own judgment: agent phases reference a skill,
 *    never embed workflow prose;
 *  - `harness.mjs` owns mechanics: op phases record the artifact paths its
 *    versioned JSON results live at — those artifacts stay authoritative.
 *
 * Everything is additive and versioned. A run without a ledger renders
 * exactly as before; an unknown future version loads as null (callers treat
 * that as "no ledger", never as an error).
 */

export const HARNESS_PROFILES = [
  'standard',
  'optimized',
  'multi',
  'multi-optimized',
  'high-assurance',
] as const;

export type HarnessProfile = (typeof HARNESS_PROFILES)[number];

export const harnessProfileSchema = z.enum(HARNESS_PROFILES);

/** One conductor phase: an agent phase (fresh session running one cez-* skill)
 *  or an op phase (a deterministic `harness.mjs` / validation invocation). */
const harnessPhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['agent', 'op']),
  /** The cez-* skill an agent phase runs (e.g. `cez-root-cause`). */
  skill: z.string().optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  attempts: z.number().int().min(0),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  /** Backend session id of the phase's fresh agent session, when kind=agent. */
  sessionId: z.string().optional(),
  error: z.string().optional(),
  /** Named artifact paths this phase produced (briefs, results, evidence). */
  artifacts: z.record(z.string(), z.string()).default({}),
});

export type HarnessPhase = z.infer<typeof harnessPhaseSchema>;

/** One model in the run's roster. For `standard` this is just the claude
 *  host; council profiles add the configured advisors (spec Phase 3). */
const harnessModelSchema = z.object({
  id: z.string().min(1),
  family: z.string().optional(),
  binding: z.string().optional(),
  roles: z.array(z.string()).default([]),
  readiness: z.enum(['ready', 'missing', 'failed', 'unknown']).default('unknown'),
  /** What the readiness probe actually observed — the upstream error for a
   *  failure, or how the round-trip succeeded. Operator-actionable detail, so
   *  a red row never sends anyone hunting through a server log. */
  readinessDetail: z.string().optional(),
  note: z.string().optional(),
  invocations: z.number().int().min(0).default(0),
  totalDurationMs: z.number().int().min(0).default(0),
});

export type HarnessModel = z.infer<typeof harnessModelSchema>;

/** One validation-gate command result — real exit codes, never a model claim. */
const validationCheckSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  exitCode: z.number().int().nullable(),
  evidence: z.string(),
});

export type HarnessValidationCheck = z.infer<typeof validationCheckSchema>;

/** Reserved council/packet shapes (spec Phases 3/5) — persisted loosely so a
 *  newer ledger read by this version never fails validation on them. */
const looseRecordSchema = z.record(z.string(), z.unknown());

const harnessStageSchema = z.object({
  status: z.enum(['pending', 'staged', 'failed']).default('pending'),
  startStatePath: z.string().optional(),
  allowlistPath: z.string().optional(),
  stagedPaths: z.array(z.string()).optional(),
  suggestedCommit: z.string().optional(),
  prBody: z.string().optional(),
  error: z.string().optional(),
});

export type HarnessStage = z.infer<typeof harnessStageSchema>;

const harnessDecisionSchema = z.object({
  at: z.string(),
  kind: z.string(),
  by: z.enum(['user', 'driver']).default('driver'),
  detail: z.string().optional(),
});

export const harnessLedgerSchema = z.object({
  version: z.literal(1),
  workflow: z.string().min(1),
  requestedProfile: harnessProfileSchema,
  /** Differs from `requestedProfile` only after an explicit, recorded user
   *  fallback decision — never silently. */
  effectiveProfile: harnessProfileSchema,
  /** The role-based selection the run was started with (2026-07-24): who
   *  orchestrates, who implements, who reviews. Loose — the driver input is
   *  authoritative; this is the report copy. */
  roles: looseRecordSchema.optional(),
  subject: z.object({
    kind: z.enum(['issue', 'brief']),
    id: z.string().optional(),
    text: z.string(),
  }),
  trustedConfig: z
    .object({ baseRef: z.string(), path: z.string(), overlay: z.boolean() })
    .optional(),
  models: z.array(harnessModelSchema).default([]),
  phases: z.array(harnessPhaseSchema).default([]),
  councils: z.array(looseRecordSchema).default([]),
  packets: z.array(looseRecordSchema).default([]),
  validation: z.array(validationCheckSchema).default([]),
  loops: z
    .object({ fixRounds: z.number().int().min(0), maxFixRounds: z.number().int().min(1) })
    .default({ fixRounds: 0, maxFixRounds: 3 }),
  claim: z.object({ held: z.boolean(), issueId: z.string().optional() }).optional(),
  stage: harnessStageSchema.default({ status: 'pending' }),
  decisions: z.array(harnessDecisionSchema).default([]),
});

export type HarnessLedger = z.infer<typeof harnessLedgerSchema>;
