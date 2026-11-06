import { z } from 'zod';
import {
  harnessProfileSchema,
  harnessSkillProfileSchema,
  type HarnessProfile,
  harnessEnvironmentSchema,
  harnessFindingHistoryRecordSchema,
  harnessReviewActionRecordSchema,
  harnessValidationCheckRecordSchema,
} from '@open-mercato/cezar-contract';

export { harnessProfileSchema, harnessSkillProfileSchema };
export type { HarnessProfile, HarnessSkillProfile } from '@open-mercato/cezar-contract';

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
 * Everything is additive and versioned. The reader distinguishes an absent
 * ledger from corrupt or future state so recovery can fail closed instead of
 * silently restarting expensive work.
 */

export const HARNESS_PROFILES = harnessProfileSchema.options;

/** A run's profile is a label derived from its lineup, never a config lookup: no lineup is Claude
 *  solo, otherwise the implementer's runner names it. */
export function harnessProfileFor(roles: { implementer: { runner: string } } | undefined): HarnessProfile {
  if (!roles) return 'standard';
  return roles.implementer.runner === 'claude' ? 'multi' : 'multi-optimized';
}

/** Which judgment playbooks the fixed harness graph executes. Generic is the
 * safe Cezar default; Open Mercato is an explicit opt-in because its skills
 * encode framework-specific architecture and repository conventions. */
export const HARNESS_SKILL_PROFILES = harnessSkillProfileSchema.options;

const harnessPhaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['agent', 'op']),
  skill: z.string().optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  attempts: z.number().int().min(0),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  artifacts: z.record(z.string(), z.string()).default({}),
});

export type HarnessPhase = z.infer<typeof harnessPhaseSchema>;

/** One model in the run's roster. For `standard` this is just the claude
 *  host; council profiles add the configured advisors (spec Phase 3). */
const harnessModelSchema = z.object({
  id: z.string().min(1),
  family: z.string().optional(),
  /** The ref's parts, kept separate so a surface never has to re-split `id`
   *  (2026-07-27). `id` is `runner/model`, so a gateway-qualified model renders
   *  as `opencode/opencode/mimo-v2.5-free` when a UI prints it whole — and `id`
   *  itself cannot change, it is the ledger's stable cross-record key. */
  runner: z.string().optional(),
  model: z.string().optional(),
  binding: z.string().optional(),
  roles: z.array(z.string()).default([]),
  readiness: z.enum(['ready', 'missing', 'failed', 'unknown']).default('unknown'),
  readinessDetail: z.string().optional(),
  note: z.string().optional(),
  invocations: z.number().int().min(0).default(0),
  totalDurationMs: z.number().int().min(0).default(0),
});

export type HarnessModel = z.infer<typeof harnessModelSchema>;

/** One validation-gate command result — real exit codes, never a model claim. */
export const validationCheckSchema = harnessValidationCheckRecordSchema;

export type HarnessValidationCheck = z.infer<typeof validationCheckSchema>;

/** Reserved council shapes (spec Phase 3) — persisted loosely so a
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

export const harnessInvocationSchema = z
  .object({
    id: z.string().min(1),
    phaseId: z.string().min(1),
    role: z.string().min(1),
    reviewerId: z.string().optional(),
    binding: z
      .object({
        runner: z.string().min(1),
        model: z.string().optional(),
        effort: z.string().optional(),
        family: z.string().optional(),
      })
      .passthrough(),
    status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted']),
    attempt: z.number().int().min(1),
    inputSha256: z.string().min(1),
    artifactPath: z.string().optional(),
    artifactSha256: z.string().optional(),
    /** The exact prompt this invocation was given (2026-07-27). Reviewers are
     *  the expensive, judgement-carrying part of a run, and until now the only
     *  record of one was its verdict — you could not read what it was asked or
     *  what it actually said. Optional: older ledgers have none, and some
     *  invocations (validation gates) have no prompt to speak of. */
    promptPath: z.string().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
    durationMs: z.number().int().min(0).optional(),
    error: z.string().optional(),
    process: z
      .object({
        pid: z.number().int().positive(),
        token: z.string().min(1),
        startedAt: z.string(),
        group: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type HarnessInvocation = z.infer<typeof harnessInvocationSchema>;

const harnessPendingMessageSchema = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    createdAt: z.string(),
    assignedToPhaseId: z.string().optional(),
    consumedAt: z.string().optional(),
    consumedByPhaseId: z.string().optional(),
  })
  .passthrough();

/** Bounds on a spec decision's findings; the writer truncates to them (`decisionFindings`). */
export const HARNESS_DECISION_FINDING_MAX = 4_000;
export const HARNESS_DECISION_FINDINGS_MAX = 50;

const harnessOutcomeSchema = z
  .object({
    status: z.enum(['pending', 'ready', 'blocked', 'contested', 'no-action']).default('pending'),
    blockingReasons: z.array(z.string()).default([]),
    acceptedAt: z.string().optional(),
    acceptedBy: z.literal('user').optional(),
    acceptanceReason: z.string().optional(),
    /** A blocked outcome the USER can resolve: a council below quorum with
     *  survivors. The UI offers "retry the failed reviewers" / "proceed with
     *  the survivors"; the decision endpoint records the choice and resumes
     *  the run. Absent on every other blocked outcome. */
    pendingDecision: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('council'),
          council: z.enum(['spec', 'implementation']),
          round: z.number().int().min(1),
          failed: z.array(
            z.object({ label: z.string(), reason: z.string().optional() }),
          ),
          completedCount: z.number().int().min(0),
          /** False when every reviewer failed — there is nothing to proceed WITH. */
          canProceed: z.boolean(),
          /** What this round's council reviewed; the decision is keyed to it
           *  (`councilDecisionDetail`). Absent on pauses recorded before it was. */
          subjectSha256: z.string().min(1).optional(),
        }),
        z.object({
          kind: z.literal('spec'),
          gate: z.enum(['council', 'pre-implement']),
          round: z.number().int().min(1),
          findings: z
            .array(z.string().min(1).max(HARNESS_DECISION_FINDING_MAX))
            .max(HARNESS_DECISION_FINDINGS_MAX),
        }),
      ])
      .optional(),
  })
  .passthrough();

const roundFindingSchema = z
  .object({
    severity: z.enum(['blocker', 'major', 'minor', 'nit']),
    title: z.string(),
    location: z.string().optional(),
    evidence: z.string().optional(),
    by: z.string().optional(),
  })
  .passthrough();

/** Where the spec and implementation loops stand, so a resume re-enters the open round
 *  instead of re-gating round 1 against a later diff. A cursor whose
 *  `basis` (what started the loop) no longer matches is ignored. */
const harnessRoundsSchema = z
  .object({
    spec: z
      .object({
        round: z.number().int().min(1),
        basis: z.string().min(1),
        specPath: z.string().min(1),
        summary: z.string(),
        files: z.array(z.string()),
        /** The council of `round` asked for these changes; its revision is next. */
        findings: z.array(roundFindingSchema).optional(),
        /** The loop finished; a resume never re-audits a spec the build already used. */
        done: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    implementation: z
      .object({
        round: z.number().int().min(1),
        basis: z.string().min(1),
        validationRepairRounds: z.number().int().min(0),
        repairPhases: z.array(z.string()),
        /** What the fix phase of `round` answers. */
        findings: z.array(roundFindingSchema),
        history: z.array(
          z.object({
            round: z.number().int().min(1),
            demanded: z.array(z.string()),
            response: z.string(),
          }),
        ),
        /** Changed paths earlier rounds reported, by the phase that first did. */
        allowlist: z.record(z.string(), z.string()),
        suggestedCommit: z.string().optional(),
        summary: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const harnessLedgerBaseShape = {
  workflow: z.string().min(1),
  requestedProfile: harnessProfileSchema,
  effectiveProfile: harnessProfileSchema,
  /** Optional only for ledgers created before selectable skill profiles. The
   * driver preserves those runs' historical Open Mercato routing. */
  skillProfile: harnessSkillProfileSchema.optional(),
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
    .object({
      baseRef: z.string(),
      path: z.string(),
      overlay: z.boolean(),
      sha256: z.string().min(1).optional(),
    })
    .optional(),
  /** SHA-256 of each complete, preflight-pinned skill directory. The pinned
   * copy lives outside the model-writable worktree and is the only prompt
   * source used on resume. */
  trustedSkills: z.record(z.string(), z.string().min(1)).default({}),
  /** The harness runtime this run executes, pinned (2026-07-27).
   *
   * The runtime used to be spawned straight from
   * `<worktree>/.claude/skills/cez-harness/scripts/harness.mjs` — a path inside
   * the tree the sandboxed worker and every agent phase can write — with the
   * full provider credential env and no integrity check. Rewriting that file
   * turned the next op into arbitrary code execution outside the worker's
   * sandbox. The bytes are now copied out of the worktree at preflight and
   * re-verified before every op. Optional only for legacy ledgers. */
  runtimeScript: z
    .object({
      path: z.string(),
      sha256: z.string().min(1),
    })
    .optional(),
  models: z.array(harnessModelSchema).default([]),
  phases: z.array(harnessPhaseSchema).default([]),
  councils: z.array(looseRecordSchema).default([]),
  validation: z.array(validationCheckSchema).default([]),
  environment: harnessEnvironmentSchema.optional(),
  findingHistory: z.array(harnessFindingHistoryRecordSchema).optional(),
  reviewAction: harnessReviewActionRecordSchema.optional(),
  /** The gate run once on the untouched worktree at capture time. A red
   *  baseline is the repo's debt, not this run's: later gates block only on
   *  regressions beyond it (run c54c2ed4 died on an upstream failure it never
   *  caused). Absent on ledgers from before the baseline gate existed. */
  baselineValidation: z.array(validationCheckSchema).optional(),
  loops: z
    .object({ fixRounds: z.number().int().min(0), maxFixRounds: z.number().int().min(1) })
    .default({ fixRounds: 0, maxFixRounds: 3 }),
  rounds: harnessRoundsSchema.optional(),
  claim: z
    .object({
      held: z.boolean(),
      issueId: z.string().optional(),
      path: z.string().optional(),
    })
    .optional(),
  stage: harnessStageSchema.default({ status: 'pending' }),
  decisions: z.array(harnessDecisionSchema).default([]),
};

export const harnessLedgerSchema = z
  .object({
    version: z.literal(2),
    ...harnessLedgerBaseShape,
    invocations: z.array(harnessInvocationSchema).default([]),
    pendingMessages: z.array(harnessPendingMessageSchema).default([]),
    outcome: harnessOutcomeSchema.default({ status: 'pending', blockingReasons: [] }),
  })
  .passthrough();

export type HarnessLedger = z.infer<typeof harnessLedgerSchema>;
