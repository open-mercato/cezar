import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * The staged multi-model harness contract. These schemas intentionally describe only the
 * stable fields the cockpit consumes; ledger records stay open so newer harness runtimes can
 * append evidence without breaking an older cockpit.
 */

export const harnessProfileSchema = z.enum([
  'standard',
  'optimized',
  'multi',
  'multi-optimized',
  'high-assurance',
]);
export type HarnessProfile = z.infer<typeof harnessProfileSchema>;

export const harnessSkillProfileSchema = z.enum(['generic', 'open-mercato']);
export type HarnessSkillProfile = z.infer<typeof harnessSkillProfileSchema>;

export const harnessEffortSchema = z.enum(['low', 'medium', 'high', 'max']);
export type HarnessEffort = z.infer<typeof harnessEffortSchema>;

export const harnessModelRefSchema = z.object({
  runner: z.union([runnerSchema, z.literal('harness')]),
  model: z.string(),
  effort: harnessEffortSchema.optional(),
  family: z.string().optional(),
  /** Internal trusted adapter binding, present on config-resolved role lineups. */
  adapterId: z.string().optional(),
});
export type HarnessModelRef = z.infer<typeof harnessModelRefSchema>;

const harnessRunnerModelRefSchema = harnessModelRefSchema.extend({
  runner: runnerSchema,
});

export const harnessRolesSchema = z.object({
  orchestrator: harnessRunnerModelRefSchema,
  implementer: harnessRunnerModelRefSchema,
  reviewers: z.array(harnessModelRefSchema),
});
export type HarnessRoles = z.infer<typeof harnessRolesSchema>;

export const harnessPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  roles: harnessRolesSchema,
});
export type HarnessPreset = z.infer<typeof harnessPresetSchema>;

export const harnessStartInputSchema = z.object({
  profile: harnessProfileSchema.optional(),
  skillProfile: harnessSkillProfileSchema.optional(),
  roles: harnessRolesSchema.optional(),
  issueId: z.string().optional(),
  baseAcknowledgement: z
    .object({
      configuredBase: z.string(),
      remoteDefault: z.string(),
      reason: z.string(),
    })
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

/** One role's recorded eval-pack score. */
export const harnessCertificationRoleSchema = z.object({
  cases: z.number(),
  passed: z.number(),
});

/**
 * Recorded eval-gate evidence for a binding (spec 2026-08-06-eval-gated-model-routing) —
 * resolved server-side from `agentHarness.certifications`. `status` is always present:
 * 'uncertified' means "no valid evidence recorded", 'stale' means the evidence aged out of
 * the freshness window (provenance fields survive so the UI can say what aged). Additive:
 * readiness stays the LIVE measurement; certification is the RECORDED one.
 */
export const harnessCertificationSchema = z.object({
  status: z.enum(['certified', 'stale', 'uncertified']),
  roles: z
    .object({
      orchestrator: harnessCertificationRoleSchema.optional(),
      implementer: harnessCertificationRoleSchema.optional(),
      reviewer: harnessCertificationRoleSchema.optional(),
    })
    .optional(),
  pack: z.string().optional(),
  catalogVersion: z.string().optional(),
  recordedAt: z.string().optional(),
});
export type HarnessCertification = z.infer<typeof harnessCertificationSchema>;

export const harnessModelSchema = z.object({
  id: z.string(),
  family: z.string().optional(),
  model: z.string().optional(),
  adapter: z.string().optional(),
  roles: z.array(z.string()),
  profiles: z.array(z.string()).optional(),
  readiness: z.enum(['ready', 'missing', 'failed', 'unknown']).optional(),
  readinessDetail: z.string().optional(),
  binding: z.string().optional(),
  certification: harnessCertificationSchema.optional(),
});
export type HarnessModel = z.infer<typeof harnessModelSchema>;

export const harnessStatusResponseSchema = z.object({
  /** The `multiModel` feature flag (off by default). The status route stays readable when
   *  disabled so Settings can explain the gate; probe and run starts answer 409. */
  enabled: z.boolean(),
  configured: z.boolean(),
  profiles: z.array(z.string()),
  driven: z.array(z.string()),
  models: z.array(harnessModelSchema),
  runtime: z.object({
    installed: z.boolean(),
    source: z.enum(['ai', 'cezar', 'agents', 'global', 'team', 'bundled']).nullable(),
    commit: z.string().nullable(),
  }),
  base: z
    .object({
      configured: z.string().nullable(),
      remoteDefault: z.string().nullable(),
      stale: z.boolean(),
      note: z.string().optional(),
    })
    .optional(),
});
export type HarnessStatusResponse = z.infer<typeof harnessStatusResponseSchema>;

export const harnessProbeInputSchema = z.object({
  profile: harnessProfileSchema.optional(),
  roles: harnessRolesSchema.optional(),
});
export type HarnessProbeInput = z.input<typeof harnessProbeInputSchema>;

export const harnessProbeResponseSchema = z.object({
  profile: z.string(),
  ready: z.boolean(),
  reason: z.string().optional(),
  models: z.array(harnessModelSchema),
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
  verdict: z.enum(['approve', 'request_changes']).optional(),
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

export const harnessPacketRecordSchema = z.looseObject({
  id: z.string(),
  originalId: z.string().optional(),
  effectiveId: z.string().optional(),
  title: z.string().optional(),
  risk: z.string().optional(),
  state: z.string().optional(),
  status: z.string().optional(),
  paths: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
  attempt: z.number().optional(),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
});
export type HarnessPacketRecord = z.infer<typeof harnessPacketRecordSchema>;

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
});
export type HarnessPendingMessageRecord = z.infer<typeof harnessPendingMessageRecordSchema>;

export const harnessDecisionRecordSchema = z.looseObject({
  at: z.string(),
  kind: z.string(),
  by: z.string(),
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

export const harnessLedgerResponseSchema = z.looseObject({
  version: z.number(),
  workflow: z.string(),
  requestedProfile: z.string(),
  effectiveProfile: z.string(),
  skillProfile: harnessSkillProfileSchema.optional(),
  phases: z.array(harnessPhaseRecordSchema),
  models: z.array(harnessModelRecordSchema),
  councils: z.array(harnessCouncilRecordSchema),
  packets: z.array(harnessPacketRecordSchema),
  invocations: z.array(harnessInvocationRecordSchema),
  pendingMessages: z.array(harnessPendingMessageRecordSchema),
  decisions: z.array(harnessDecisionRecordSchema).optional(),
  stage: harnessStageRecordSchema,
  outcome: harnessOutcomeRecordSchema,
  snapshotSeq: z.number().optional(),
  loops: z.object({ fixRounds: z.number(), maxFixRounds: z.number() }).optional(),
});
export type HarnessLedgerResponse = z.infer<typeof harnessLedgerResponseSchema>;
