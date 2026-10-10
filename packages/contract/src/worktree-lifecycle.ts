import { z } from 'zod';
import { runIdParamSchema } from './events.ts';

export const lifecycleIdSchema = z.string().uuid();
export const lifecyclePhaseSchema = z.enum(['setup', 'teardown']);
export const lifecycleIntentSchema = z.enum(['create', 'recreate', 'remove-worktree', 'delete-task', 'reclaim', 'discard-variant', 'orphan']);
export const lifecycleStateSchema = z.enum(['queued', 'running', 'needs_attention', 'interrupted', 'committing', 'completed', 'bypassed', 'cancelled', 'kept']);
export const lifecycleActionSchema = z.enum(['retry', 'start-anyway', 'cancel-task', 'keep-worktree', 'force-delete', 'stop']);
export type LifecyclePhase = z.infer<typeof lifecyclePhaseSchema>;
export type LifecycleIntent = z.infer<typeof lifecycleIntentSchema>;
export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type LifecycleAction = z.infer<typeof lifecycleActionSchema>;

export const scriptEntrySchema = z.object({
  id: lifecycleIdSchema,
  name: z.string().max(120).optional(),
  command: z.string().max(32 * 1024).refine(command => command.trim().length > 0, 'Command must not be blank'),
  timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
}).strict();
export type ScriptEntry = z.infer<typeof scriptEntrySchema>;
export const worktreeLifecycleConfigSchema = z.object({
  afterCreate: z.array(scriptEntrySchema).max(32),
  beforeRemove: z.array(scriptEntrySchema).max(32),
}).strict().superRefine((config, ctx) => {
  const seen = new Set<string>();
  for (const phase of ['afterCreate', 'beforeRemove'] as const) {
    config[phase].forEach((entry, index) => {
      if (seen.has(entry.id)) ctx.addIssue({ code: 'custom', path: [phase, index, 'id'], message: 'Entry IDs must be unique across both lists' });
      seen.add(entry.id);
    });
  }
});
export type WorktreeLifecycleConfig = z.infer<typeof worktreeLifecycleConfigSchema>;

export const worktreeLifecycleProjectionSchema = z.object({
  worktreeId: lifecycleIdSchema,
  generation: z.number().int().positive(),
  activeOperationId: lifecycleIdSchema.optional(),
  phase: lifecyclePhaseSchema.optional(),
  state: lifecycleStateSchema.optional(),
  needsAttention: z.boolean(),
});
export type WorktreeLifecycleProjection = z.infer<typeof worktreeLifecycleProjectionSchema>;

export const worktreeLifecycleRecordSchema = z.object({
  schemaVersion: z.literal(1),
  worktreeId: lifecycleIdSchema,
  runId: runIdParamSchema.shape.id,
  projectRoot: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().optional(),
  generation: z.number().int().positive(),
  preparedBy: z.enum(['completed', 'bypassed']).optional(),
  autoCleanupSuppressed: z.boolean(),
  activeOperationId: lifecycleIdSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();
export type WorktreeLifecycleRecord = z.infer<typeof worktreeLifecycleRecordSchema>;

/** Process identity is deliberately absent from all public operation views. */
export const lifecycleProcessIdentitySchema = z.object({
  pid: z.number().int().positive(),
  hostname: z.string(),
  startedAt: z.string(),
  startIdentity: z.string().optional(),
  quiescent: z.boolean().optional(),
}).passthrough();
export type LifecycleProcessIdentity = z.infer<typeof lifecycleProcessIdentitySchema>;
export const scriptExecutionSchema = z.object({
  id: lifecycleIdSchema,
  operationId: lifecycleIdSchema,
  entryId: lifecycleIdSchema,
  fingerprint: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  label: z.string(),
  commandPreview: z.string(),
  attempt: z.number().int().positive(),
  state: z.enum(['running', 'succeeded', 'failed', 'interrupted', 'skipped']),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  reason: z.string().optional(),
  outputStartSeq: z.number().int().nonnegative().optional(),
  outputEndSeq: z.number().int().nonnegative().optional(),
  outputTruncated: z.boolean().optional(),
  process: lifecycleProcessIdentitySchema.optional(),
}).passthrough();
export type ScriptExecution = z.infer<typeof scriptExecutionSchema>;

export const lifecyclePendingLaunchSchema = z.object({
  kind: z.enum(['initial', 'continuation']),
  runId: runIdParamSchema.shape.id,
  message: z.string().optional(),
}).passthrough();
export type LifecyclePendingLaunch = z.infer<typeof lifecyclePendingLaunchSchema>;
export const lifecycleOperationSchema = z.object({
  schemaVersion: z.literal(1),
  id: lifecycleIdSchema,
  worktreeId: lifecycleIdSchema,
  generation: z.number().int().positive(),
  phase: lifecyclePhaseSchema,
  intent: lifecycleIntentSchema,
  state: lifecycleStateSchema,
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
  pendingLaunch: lifecyclePendingLaunchSchema.optional(),
  failureStage: z.enum(['config', 'context', 'storage', 'command', 'commit', 'process']).optional(),
  error: z.string().optional(),
  decision: z.object({ action: lifecycleActionSchema, actor: z.string(), at: z.string() }).optional(),
  configRevision: z.string().nullable().optional(),
  executions: z.array(scriptExecutionSchema).max(100),
  /** Compact successes survive history pruning; these are facts, never executable snapshots. */
  successfulEntries: z.array(z.object({ entryId: lifecycleIdSchema, fingerprint: z.string() })).default([]),
  requests: z.array(z.object({ requestId: lifecycleIdSchema, bodyHash: z.string() })).default([]),
}).passthrough();
export type LifecycleOperation = z.infer<typeof lifecycleOperationSchema>;

export const lifecycleEntrySummarySchema = z.object({
  entryId: lifecycleIdSchema,
  label: z.string(),
  commandPreview: z.string(),
  state: z.enum(['pending', 'running', 'succeeded', 'failed', 'interrupted', 'already-completed', 'skipped', 'removed']),
  attempt: z.number().int().nonnegative(),
});
export const lifecycleExecutionViewSchema = scriptExecutionSchema.omit({ process: true }).strip();
export const lifecycleOperationViewSchema = lifecycleOperationSchema.omit({ schemaVersion: true, pendingLaunch: true, requests: true, successfulEntries: true, executions: true }).strip().extend({
  history: z.array(lifecycleExecutionViewSchema),
  entries: z.array(lifecycleEntrySummarySchema),
  allowedActions: z.array(lifecycleActionSchema),
});
export type LifecycleOperationView = z.infer<typeof lifecycleOperationViewSchema>;
export const worktreeLifecycleSummarySchema = z.object({
  worktreeId: lifecycleIdSchema,
  runId: runIdParamSchema.shape.id,
  task: z.object({ id: runIdParamSchema.shape.id, title: z.string() }).nullable(),
  worktreePath: z.string(),
  generation: z.number().int().positive(),
  onDisk: z.boolean(),
  prepared: z.boolean(),
  needsAttention: z.boolean(),
  autoCleanupSuppressed: z.boolean(),
  operation: lifecycleOperationViewSchema.optional(),
  error: z.string().optional(),
});
export type WorktreeLifecycleSummary = z.infer<typeof worktreeLifecycleSummarySchema>;
export const worktreeLifecycleDetailSchema = worktreeLifecycleSummarySchema.extend({ history: z.array(lifecycleOperationViewSchema) });
export type WorktreeLifecycleDetail = z.infer<typeof worktreeLifecycleDetailSchema>;

export const startLifecycleRemovalInputSchema = z.union([
  z.object({ requestId: lifecycleIdSchema, runId: runIdParamSchema.shape.id, intent: z.enum(['remove-worktree', 'delete-task', 'reclaim']) }).strict(),
  z.object({ requestId: lifecycleIdSchema, worktreeId: lifecycleIdSchema, intent: z.literal('orphan') }).strict(),
]);
export type StartLifecycleRemovalInput = z.infer<typeof startLifecycleRemovalInputSchema>;
export const lifecycleActionInputSchema = z.object({ requestId: lifecycleIdSchema, expectedRevision: z.number().int().nonnegative(), action: lifecycleActionSchema }).strict();
export type LifecycleActionInput = z.infer<typeof lifecycleActionInputSchema>;
export const lifecycleWorktreeParamSchema = z.object({ worktreeId: lifecycleIdSchema });
export const lifecycleOperationParamSchema = z.object({ operationId: lifecycleIdSchema });
export const lifecycleListQuerySchema = z.object({
  attentionOnly: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  cursor: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const lifecycleListResponseSchema = z.object({ worktrees: z.array(worktreeLifecycleSummarySchema), nextCursor: z.string().optional() });
export const lifecycleDetailResponseSchema = z.object({ worktree: worktreeLifecycleDetailSchema });
export const lifecycleOperationResponseSchema = z.object({ operation: lifecycleOperationViewSchema });
export const lifecycleOutputFrameSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.string(),
  executionId: lifecycleIdSchema,
  stream: z.enum(['stdout', 'stderr', 'system']),
  text: z.string().max(16 * 1024),
});
export type LifecycleOutputFrame = z.infer<typeof lifecycleOutputFrameSchema>;
export const lifecycleOutputQuerySchema = z.object({ afterSeq: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const lifecycleOutputResponseSchema = z.object({ items: z.array(lifecycleOutputFrameSchema), nextSeq: z.number().int().nonnegative(), truncated: z.boolean() });
export type LifecycleOutputResponse = z.infer<typeof lifecycleOutputResponseSchema>;
export const lifecyclePreviewInputSchema = z.object({ command: scriptEntrySchema.shape.command, worktreeId: lifecycleIdSchema.optional() }).strict();
export const lifecycleTemplateVariablesSchema = z.object({ root_path: z.string(), worktree_path: z.string(), worktree_id: z.string(), task_id: z.string() });
export type LifecycleTemplateVariables = z.infer<typeof lifecycleTemplateVariablesSchema>;
export const lifecyclePreviewResponseSchema = z.object({ renderedCommand: z.string(), variables: lifecycleTemplateVariablesSchema, cwd: z.string(), illustrative: z.boolean() });
export type LifecyclePreviewResponse = z.infer<typeof lifecyclePreviewResponseSchema>;
export const worktreeLifecycleInvalidationSchema = z.object({ projectId: z.string(), worktreeId: lifecycleIdSchema, operationId: lifecycleIdSchema.optional(), revision: z.number().int().nonnegative() });
export type WorktreeLifecycleInvalidation = z.infer<typeof worktreeLifecycleInvalidationSchema>;
