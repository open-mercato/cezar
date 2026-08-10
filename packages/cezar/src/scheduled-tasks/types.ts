import { z } from 'zod';
import { workflowStepSchema } from '../workflows/types.ts';

/**
 * Storage-side schemas for one-time scheduled tasks (spec 2026-08-01-postponed-tasks).
 *
 * Like `../automations/types.ts` these are permissive and `.passthrough()`: a definitions/state/
 * occurrence file written by a NEWER cezar must survive a round trip through an older one rather
 * than lose keys it has never heard of. The loader salvages entry by entry. The CLOSED wire half
 * lives in `packages/contract/src/scheduled-tasks.ts`.
 */

/** The reusable task payload — the composer's own run body minus browser-only images/inbox id. */
export const scheduledTaskTemplateSchema = z
  .object({
    prompt: z.string().min(1).max(100_000),
    workflow: z.string().trim().min(1).max(200).optional(),
    steps: z.array(workflowStepSchema).min(1).max(100).optional(),
    runner: z.enum(['claude', 'codex', 'opencode']).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    agentProfile: z.string().trim().min(1).max(64).optional(),
    variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    worktree: z.boolean().optional(),
    autonomous: z.boolean().optional(),
    generateFollowups: z.boolean().optional(),
    systemPrompt: z.string().max(100_000).optional(),
  })
  .passthrough()
  .refine((task) => !(task.workflow && task.steps), {
    message: 'task selects either a named workflow or inline steps, not both',
  });

export const scheduledTaskTimingSchema = z
  .object({
    kind: z.literal('once'),
    at: z.string().datetime(),
    timezone: z.string().trim().min(1).max(200),
  })
  .passthrough();

export const scheduledTaskDefinitionSchema = z
  .object({
    id: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().default(true),
    timing: scheduledTaskTimingSchema,
    task: scheduledTaskTemplateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();

export const scheduledTaskDefinitionsFileSchema = z
  .object({
    version: z.literal(1).default(1),
    scheduledTasks: z.array(z.unknown()).default([]),
    tombstones: z.record(z.string(), z.string().datetime()).optional(),
  })
  .passthrough();

export const scheduledTaskStatusSchema = z.enum([
  'pending',
  'paused',
  'launching',
  'completed',
  'error',
]);

export const scheduledTaskRuntimeStateSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    status: scheduledTaskStatusSchema.optional(),
    nextDueAt: z.string().datetime().optional(),
    lastOccurrenceId: z.string().optional(),
    lastRunId: z.string().optional(),
    lastObservedAt: z.string().datetime().optional(),
    consecutiveFailures: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const scheduledTaskStateFileSchema = z
  .object({
    version: z.literal(1).default(1),
    states: z.record(z.string(), scheduledTaskRuntimeStateSchema).default({}),
  })
  .passthrough();

export const scheduledTaskOccurrenceStatusSchema = z.enum([
  'reserved',
  'launched',
  'launch-error',
  'config-error',
]);

export const scheduledTaskTriggerSchema = z.enum(['scheduled', 'manual']);

export const scheduledTaskOccurrenceSchema = z
  .object({
    seq: z.number().int().positive(),
    occurrenceId: z.string().min(1),
    occurrenceKey: z.string().min(1),
    scheduledTaskId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    scheduledFor: z.string().datetime(),
    observedAt: z.string().datetime(),
    trigger: scheduledTaskTriggerSchema,
    status: scheduledTaskOccurrenceStatusSchema,
    reason: z.string().max(2_000).optional(),
    runId: z.string().optional(),
    groupId: z.string().optional(),
    updatedAt: z.string().datetime(),
  })
  .passthrough();

export type ScheduledTaskTemplate = z.infer<typeof scheduledTaskTemplateSchema>;
export type ScheduledTaskTiming = z.infer<typeof scheduledTaskTimingSchema>;
export type ScheduledTaskDefinition = z.infer<typeof scheduledTaskDefinitionSchema>;
export type ScheduledTaskStatus = z.infer<typeof scheduledTaskStatusSchema>;
export type ScheduledTaskRuntimeState = z.infer<typeof scheduledTaskRuntimeStateSchema>;
export type ScheduledTaskOccurrence = z.infer<typeof scheduledTaskOccurrenceSchema>;
export type ScheduledTaskOccurrenceStatus = z.infer<typeof scheduledTaskOccurrenceStatusSchema>;
export type ScheduledTaskTrigger = z.infer<typeof scheduledTaskTriggerSchema>;
