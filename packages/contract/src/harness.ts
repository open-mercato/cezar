import { z } from 'zod';

/**
 * The staged multi-model harness contract. These schemas intentionally describe only the
 * stable fields the cockpit consumes; ledger records stay open so newer harness runtimes can
 * append evidence without breaking an older cockpit.
 */

export const harnessProfileSchema = z.enum([
  'standard',
  'multi',
  'multi-optimized',
]);
export type HarnessProfile = z.infer<typeof harnessProfileSchema>;

export const harnessSkillProfileSchema = z.enum(['generic', 'open-mercato']);
export type HarnessSkillProfile = z.infer<typeof harnessSkillProfileSchema>;

export const harnessEffortSchema = z.enum(['low', 'medium', 'high', 'max']);
export type HarnessEffort = z.infer<typeof harnessEffortSchema>;

/** Runners the harness conductor can probe and bind today. Pi remains available to ordinary
 * runs, but it has no harness probe transport yet and must not be accepted as a role binding. */
export const harnessRunnerSchema = z.enum(['claude', 'codex', 'opencode']);
export type HarnessRunner = z.infer<typeof harnessRunnerSchema>;

export const harnessModelRefSchema = z.object({
  runner: z.union([harnessRunnerSchema, z.literal('harness')]),
  model: z.string(),
  effort: harnessEffortSchema.optional(),
  family: z.string().optional(),
});
export type HarnessModelRef = z.infer<typeof harnessModelRefSchema>;

const harnessRunnerModelRefSchema = harnessModelRefSchema.extend({
  runner: harnessRunnerSchema,
});

export const harnessRolesSchema = z.object({
  orchestrator: harnessRunnerModelRefSchema,
  implementer: harnessRunnerModelRefSchema,
  reviewers: z.array(harnessModelRefSchema),
});
export type HarnessRoles = z.infer<typeof harnessRolesSchema>;

// Public inputs cannot grant internal adapter bindings or bypass council limits.
const harnessRunnerInputSchema = z.object({
  runner: harnessRunnerSchema,
  model: z.string().max(200),
  effort: harnessEffortSchema.optional(),
});
const harnessAdvisorInputSchema = z.object({
  runner: z.literal('harness'),
  model: z.string().min(1).max(200),
  family: z.string().min(1).max(80).optional(),
});
export const harnessRolesInputSchema = z.object({
  orchestrator: harnessRunnerInputSchema,
  implementer: harnessRunnerInputSchema,
  reviewers: z.array(z.union([harnessRunnerInputSchema, harnessAdvisorInputSchema]))
    .min(2, 'pick at least 2 reviewers — multi-model means more than one voice')
    .max(5, 'pick at most 5 reviewers'),
}).superRefine((roles, ctx) => {
  const seen = new Set<string>();
  for (const reviewer of roles.reviewers) {
    const key = `${reviewer.runner}::${reviewer.model}`;
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', message: 'reviewers must be unique models' });
      return;
    }
    seen.add(key);
  }
});

export const harnessPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  roles: harnessRolesSchema,
});
export type HarnessPreset = z.infer<typeof harnessPresetSchema>;

/** New saved lineups are bounded; older stored presets remain readable above. */
export const harnessPresetInputSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  roles: harnessRolesInputSchema,
});

export const harnessStartInputSchema = z.object({
  /** Derived from the lineup; a value that disagrees with it answers 400 (named profiles no
   *  longer resolve, and ignoring one would silently run Claude solo). */
  profile: harnessProfileSchema.optional(),
  skillProfile: harnessSkillProfileSchema.optional(),
  roles: harnessRolesInputSchema.optional(),
  issueId: z.string().trim().min(1).max(200).optional(),
  baseAcknowledgement: z
    .object({
      configuredBase: z.string().trim().min(1).max(200),
      remoteDefault: z.string().trim().min(1).max(200),
      reason: z.string().trim().min(3).max(2_000),
    })
    .strict()
    .optional(),
});
export type HarnessStartInput = z.input<typeof harnessStartInputSchema>;

export const harnessRunStubSchema = z.object({
  profile: z.string(),
  workflow: z.string(),
  skillProfile: harnessSkillProfileSchema.optional(),
  issueId: z.string().optional(),
  roles: harnessRolesSchema.optional(),
  baseAcknowledgement: z
    .object({
      configuredBase: z.string(),
      remoteDefault: z.string(),
      reason: z.string(),
    })
    .optional(),
});
export type HarnessRunStub = z.infer<typeof harnessRunStubSchema>;

export const harnessModelSchema = z.object({
  id: z.string(),
  family: z.string().optional(),
  model: z.string().optional(),
  adapter: z.string().optional(),
  roles: z.array(z.string()),
  readiness: z.enum(['ready', 'missing', 'failed', 'unknown']).optional(),
  readinessDetail: z.string().optional(),
  binding: z.string().optional(),
  /** A configured binding that makes exactly the call a runner-backed reviewer already makes
   *  (the same trusted endpoint preset and model, or the same `codex exec` review command) —
   *  the composer lists that model once, under the runner spelling. Absent = no equivalent. */
  sameAs: z.object({ runner: z.enum(['codex', 'opencode']), model: z.string() }).optional(),
});
export type HarnessModel = z.infer<typeof harnessModelSchema>;

/** One `/harness/status` roster row, never a live readiness (that is the probe's). Assignable to
 *  `HarnessModel`. */
export const harnessStatusModelSchema = z.object({
  id: z.string(),
  family: z.string().optional(),
  model: z.string().optional(),
  adapter: z.string().optional(),
  roles: z.array(z.string()),
  sameAs: harnessModelSchema.shape.sameAs,
});
export type HarnessStatusModel = z.infer<typeof harnessStatusModelSchema>;

/** One `/harness/probe` row: the binding as probed and its live readiness. Assignable to
 *  `HarnessModel`. */
export const harnessProbeModelSchema = z.object({
  id: z.string(),
  family: z.string(),
  binding: z.string(),
  roles: z.array(z.string()),
  readiness: z.enum(['ready', 'failed', 'unknown']),
  readinessDetail: z.string().optional(),
});
export type HarnessProbeModel = z.infer<typeof harnessProbeModelSchema>;

export const harnessStatusResponseSchema = z.object({
  /** The `multiModel` feature flag (off by default). The status route stays readable when
   *  disabled so Settings can explain the gate; probe and run starts answer 409. */
  enabled: z.boolean(),
  configured: z.boolean(),
  models: z.array(harnessStatusModelSchema),
  runtime: z.object({
    installed: z.boolean(),
    source: z.enum(['ai', 'cezar', 'agents', 'global', 'team', 'bundled']).nullable(),
    commit: z.string().nullable(),
  }),
  base: z.object({
    configured: z.string().nullable(),
    remoteDefault: z.string().nullable(),
    stale: z.boolean(),
    note: z.string().optional(),
  }),
});
export type HarnessStatusResponse = z.infer<typeof harnessStatusResponseSchema>;

export const harnessProbeInputSchema = z.object({
  roles: harnessRolesInputSchema,
}).strict();
export type HarnessProbeInput = z.input<typeof harnessProbeInputSchema>;

export const harnessProbeResponseSchema = z.object({
  profile: harnessProfileSchema,
  ready: z.boolean(),
  reason: z.string().optional(),
  models: z.array(harnessProbeModelSchema),
});
export type HarnessProbeResponse = z.infer<typeof harnessProbeResponseSchema>;

export const harnessPhaseRecordSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'op']),
  skill: z.string().optional(),
  status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
  attempts: z.number(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  artifacts: z.record(z.string(), z.string()),
});
export type HarnessPhaseRecord = z.infer<typeof harnessPhaseRecordSchema>;

export const harnessModelRecordSchema = z.looseObject({
  id: z.string(),
  family: z.string().optional(),
  runner: z.string().optional(),
  model: z.string().optional(),
  binding: z.string().optional(),
  roles: z.array(z.string()),
  readiness: z.enum(['ready', 'missing', 'failed', 'unknown']),
  readinessDetail: z.string().optional(),
  note: z.string().optional(),
  invocations: z.number(),
  totalDurationMs: z.number(),
});
export type HarnessModelRecord = z.infer<typeof harnessModelRecordSchema>;

export const harnessFindingRecordSchema = z.looseObject({
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  title: z.string(),
  location: z.string().optional(),
  evidence: z.string().optional(),
  by: z.string().optional(),
});
export type HarnessFindingRecord = z.infer<typeof harnessFindingRecordSchema>;

export const harnessReviewerRecordSchema = z.looseObject({
  id: z.string(),
  runner: z.string().optional(),
  model: z.string().optional(),
  family: z.string().optional(),
  status: z.string().optional(),
  freshContext: z.boolean().optional(),
  /** `null` when the reviewer produced no verdict — a failed advisor (the driver's durable
   *  ledger format, as on the council row below). Rejecting it made ONE failed reviewer fail the
   *  whole ledger parse, blanking the run's models rail and review tab (2026-09-30). */
  verdict: z.enum(['approve', 'request_changes']).nullable().optional(),
  findings: z.array(harnessFindingRecordSchema).optional(),
  reason: z.string().optional(),
  error: z.string().optional(),
});
export type HarnessReviewerRecord = z.infer<typeof harnessReviewerRecordSchema>;

export const harnessCouncilRecordSchema = z.looseObject({
  round: z.number(),
  kind: z.string(),
  reviewers: z.array(harnessReviewerRecordSchema).optional(),
  verdict: z.enum(['approve', 'request_changes']).nullable().optional(),
  findings: z.array(harnessFindingRecordSchema).optional(),
});
export type HarnessCouncilRecord = z.infer<typeof harnessCouncilRecordSchema>;

export const harnessInvocationRecordSchema = z.looseObject({
  id: z.string(),
  phaseId: z.string(),
  role: z.string(),
  reviewerId: z.string().optional(),
  binding: z.looseObject({
    runner: z.string(),
    model: z.string().optional(),
    effort: z.string().optional(),
    family: z.string().optional(),
  }),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'interrupted']),
  attempt: z.number(),
  inputSha256: z.string(),
  artifactPath: z.string().optional(),
  artifactSha256: z.string().optional(),
  promptPath: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  process: z
    .looseObject({
      pid: z.number(),
      token: z.string(),
      startedAt: z.string(),
      group: z.boolean().optional(),
    })
    .optional(),
});
export type HarnessInvocationRecord = z.infer<typeof harnessInvocationRecordSchema>;

export const harnessInvocationDetailSchema = z.object({
  id: z.string(),
  reviewerId: z.string().optional(),
  role: z.string(),
  phaseId: z.string(),
  status: harnessInvocationRecordSchema.shape.status,
  attempt: z.number(),
  binding: harnessInvocationRecordSchema.shape.binding,
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  error: z.string().optional(),
  prompt: z.string().nullable(),
  result: z.string().nullable(),
});
export type HarnessInvocationDetail = z.infer<typeof harnessInvocationDetailSchema>;

export const harnessPendingMessageRecordSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
  assignedToPhaseId: z.string().optional(),
  consumedAt: z.string().optional(),
  consumedByPhaseId: z.string().optional(),
});
export type HarnessPendingMessageRecord = z.infer<typeof harnessPendingMessageRecordSchema>;

export const harnessDecisionRecordSchema = z.object({
  at: z.string(),
  kind: z.string(),
  by: z.enum(['user', 'driver']),
  detail: z.string().optional(),
});
export type HarnessDecisionRecord = z.infer<typeof harnessDecisionRecordSchema>;

export const harnessCouncilPendingDecisionSchema = z.looseObject({
  kind: z.literal('council'),
  council: z.enum(['spec', 'implementation']),
  round: z.number(),
  failed: z.array(z.object({ label: z.string(), reason: z.string().optional() })),
  completedCount: z.number(),
  canProceed: z.boolean(),
  subjectSha256: z.string().optional(),
});
export type HarnessCouncilPendingDecision = z.infer<typeof harnessCouncilPendingDecisionSchema>;

export const harnessSpecPendingDecisionSchema = z.looseObject({
  kind: z.literal('spec'),
  gate: z.enum(['council', 'pre-implement']),
  round: z.number(),
  findings: z.array(z.string()),
});
export type HarnessSpecPendingDecision = z.infer<typeof harnessSpecPendingDecisionSchema>;

export const harnessOutcomeRecordSchema = z.looseObject({
  status: z.enum(['pending', 'ready', 'blocked', 'contested', 'no-action']),
  blockingReasons: z.array(z.string()),
  acceptedAt: z.string().optional(),
  acceptedBy: z.literal('user').optional(),
  acceptanceReason: z.string().optional(),
  pendingDecision: z
    .union([harnessCouncilPendingDecisionSchema, harnessSpecPendingDecisionSchema])
    .optional(),
});
export type HarnessOutcomeRecord = z.infer<typeof harnessOutcomeRecordSchema>;

export const harnessStageRecordSchema = z.looseObject({
  status: z.enum(['pending', 'staged', 'failed']),
  startStatePath: z.string().optional(),
  allowlistPath: z.string().optional(),
  stagedPaths: z.array(z.string()).optional(),
  suggestedCommit: z.string().optional(),
  prBody: z.string().optional(),
  error: z.string().optional(),
});
export type HarnessStageRecord = z.infer<typeof harnessStageRecordSchema>;

/** `POST /runs/:id/harness/accept-contested` — the user's reason for accepting the risk. */
export const harnessAcceptContestedInputSchema = z
  .object({ reason: z.string().trim().min(3).max(2_000) })
  .strict();
export type HarnessAcceptContestedInput = z.infer<typeof harnessAcceptContestedInputSchema>;

/** `resumed` only when the acceptance was a paused spec gate's, which resumes the run. */
export const harnessAcceptContestedResponseSchema = z.object({
  outcome: harnessOutcomeRecordSchema,
  decisions: z.array(harnessDecisionRecordSchema),
  resumed: z.literal(true).optional(),
});
export type HarnessAcceptContestedResponse = z.infer<typeof harnessAcceptContestedResponseSchema>;

/** `POST /runs/:id/harness/council-decision` — resolve a council paused below quorum. */
export const harnessCouncilDecisionInputSchema = z
  .object({ action: z.enum(['retry', 'proceed']) })
  .strict();
export type HarnessCouncilDecisionInput = z.infer<typeof harnessCouncilDecisionInputSchema>;

export const harnessCouncilDecisionResponseSchema = z.object({
  resumed: z.literal(true),
  decisions: z.array(harnessDecisionRecordSchema),
});
export type HarnessCouncilDecisionResponse = z.infer<typeof harnessCouncilDecisionResponseSchema>;

export const harnessLedgerResponseSchema = z.looseObject({
  version: z.literal(2),
  workflow: z.string(),
  requestedProfile: harnessProfileSchema,
  effectiveProfile: harnessProfileSchema,
  skillProfile: harnessSkillProfileSchema.optional(),
  phases: z.array(harnessPhaseRecordSchema),
  models: z.array(harnessModelRecordSchema),
  councils: z.array(harnessCouncilRecordSchema),
  invocations: z.array(harnessInvocationRecordSchema),
  pendingMessages: z.array(harnessPendingMessageRecordSchema),
  decisions: z.array(harnessDecisionRecordSchema).optional(),
  stage: harnessStageRecordSchema,
  outcome: harnessOutcomeRecordSchema,
  snapshotSeq: z.number().optional(),
  loops: z.object({ fixRounds: z.number(), maxFixRounds: z.number() }).optional(),
});
export type HarnessLedgerResponse = z.infer<typeof harnessLedgerResponseSchema>;
