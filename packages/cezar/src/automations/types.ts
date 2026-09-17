import { z } from 'zod';
import { DISPATCH_MAX_SUBTASKS, automationScheduleSchema, type AutomationSchedule } from '@open-mercato/cezar-contract';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { workflowStepSchema } from '../workflows/types.ts';

export const automationEventSchema = z.enum([
  'pull_request.opened',
  'issue.opened',
  'issue.labeled',
  'issue.unlabeled',
]);

const boundedString = z.string().trim().min(1).max(200);
const stringList = z.array(boundedString).max(100).optional();

export const automationFiltersSchema = z
  .object({
    authors: stringList,
    assignees: stringList,
    allLabels: stringList,
    anyLabels: stringList,
    excludeLabels: stringList,
    changedLabels: stringList,
    lookbackDays: z.number().int().min(1).max(90).default(7),
    maxRecords: z.number().int().min(1).max(100).default(25),
  })
  .passthrough();

export const automationTaskSchema = z
  .object({
    prompt: z.string().min(1).max(100_000),
    workflow: z.string().trim().min(1).max(200).optional(),
    steps: z.array(workflowStepSchema).min(1).max(100).optional(),
    runner: z.enum(RUNNER_IDS).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    worktree: z.boolean().optional(),
    generateFollowups: z.boolean().optional(),
    autonomous: z.boolean().optional(),
    systemPrompt: z.string().max(100_000).optional(),
    /** The automation's own dispatch setting (spec 2026-09-14 Q4). */
    dispatch: z
      .object({
        maxSubtasks: z.number().int().min(1).max(DISPATCH_MAX_SUBTASKS).optional(),
        reviewChild: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine((task) => !(task.workflow && task.steps), {
    message: 'task selects either a named workflow or inline steps, not both',
  });

/**
 * A poll's two defaulted keys are filled BEFORE parsing, and only for the poll kind: `.default()`
 * on the keys themselves would also stamp `intervalSeconds: 300` and an empty filter onto every
 * scheduled definition, and the routes then read those as a GitHub filter on a schedule.
 */
const fillGithubDefaults = (raw: unknown): unknown => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (record.kind === 'schedule') return raw;
  return {
    ...record,
    intervalSeconds: record.intervalSeconds ?? 300,
    filters: record.filters ?? {},
  };
};

/** The definition's object shape, before the poll-default preprocess — what a key inventory reads. */
export const automationDefinitionObjectSchema = z
  .object({
    id: z.string().min(1).max(100),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().default(false),
    /** A definition written before schedules (spec 2026-09-14) has no `kind`: it is a poll. */
    kind: z.enum(['github', 'schedule']).default('github'),
    events: z.array(automationEventSchema).min(1).max(4).optional(),
    intervalSeconds: z.number().int().min(60).max(86_400).optional(),
    filters: automationFiltersSchema.optional(),
    schedule: automationScheduleSchema.optional(),
    task: automationTaskSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .passthrough()
  .superRefine((definition, ctx) => {
    if (definition.kind === 'schedule') {
      if (!definition.schedule) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['schedule'], message: 'a scheduled automation needs a schedule' });
      }
      return;
    }
    // github kind: the three poll keys are required, as they always were.
    if (!definition.events?.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['events'], message: 'a GitHub automation needs at least one event' });
    }
    if (definition.intervalSeconds === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['intervalSeconds'], message: 'a GitHub automation needs a poll interval' });
    }
    if (!definition.filters) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters'], message: 'a GitHub automation needs its bounded filter' });
    }
    if (
      definition.events?.some((event) => event === 'issue.labeled' || event === 'issue.unlabeled') &&
      !definition.filters?.changedLabels?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filters', 'changedLabels'],
        message: 'changedLabels is required for issue label events',
      });
    }
  });

export const automationDefinitionSchema = z.preprocess(fillGithubDefaults, automationDefinitionObjectSchema);

export const automationDefinitionsFileSchema = z
  .object({
    version: z.literal(1).default(1),
    automations: z.array(z.unknown()).default([]),
    tombstones: z.record(z.string(), z.string().datetime()).optional(),
  })
  .passthrough();

export const automationCursorSchema = z
  .object({
    timestamp: z.string().datetime(),
    tieBreaker: z.string().optional(),
  })
  .passthrough();

export const automationRuntimeStateSchema = z
  .object({
    revision: z.number().int().positive().optional(),
    baselineAt: z.string().datetime().optional(),
    cursor: automationCursorSchema.optional(),
    frozenHighWatermark: automationCursorSchema
      .extend({ tieBreaker: z.string() })
      .optional(),
    backlogAfter: automationCursorSchema.extend({ tieBreaker: z.string() }).optional(),
    /**
     * The cursor a widening re-poll failed to get past, even at the 100-record search ceiling
     * (#982). While `cursor` still equals it the scheduler skips the climb, so a band saturated at
     * the API's own ceiling costs one climb, not one per interval; the cursor moving clears it.
     */
    pinnedCursor: automationCursorSchema.optional(),
    nextCheckAt: z.string().datetime().optional(),
    lastSuccessAt: z.string().datetime().optional(),
    /** schedule kind (spec 2026-09-14): the next occurrence's instant and the last fired one's. */
    nextRunAt: z.string().datetime().optional(),
    lastRunAt: z.string().datetime().optional(),
    etags: z.record(z.string(), z.string()).optional(),
    backoffUntil: z.string().datetime().optional(),
    consecutiveFailures: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const automationStateFileSchema = z
  .object({
    version: z.literal(1).default(1),
    states: z.record(z.string(), automationRuntimeStateSchema).default({}),
  })
  .passthrough();

export const automationReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    receiptKey: z.string().min(1),
    eventId: z.string().min(1),
    automationId: z.string().min(1),
    revision: z.number().int().positive(),
    status: z.enum(['reserved', 'launched', 'launch-error']),
    runId: z.string().optional(),
    observedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    error: z.string().max(2_000).optional(),
    /** schedule kind: the occurrence this receipt reserved, so a retry can fire it again. */
    occurrenceAt: z.string().datetime().optional(),
    candidate: z
      .object({
        eventId: z.string(), event: automationEventSchema, timestamp: z.string().datetime(),
        tieBreaker: z.string(), repo: z.string(), nodeId: z.string(), number: z.number().int().positive(),
        title: z.string().max(500), url: z.string().url(), author: z.string().max(200),
        assignees: z.array(z.string().max(200)).max(100), labels: z.array(z.string().max(200)).max(100),
        changedLabel: z.string().max(200).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const automationLogResultSchema = z.enum([
  'launched',
  'no-match',
  'duplicate',
  'rate-limited',
  'error',
  'baseline',
  'preview',
  // schedule kind (spec 2026-09-14)
  'manual',
  'catch-up',
  'skipped',
  'failed',
]);

export const automationLogRecordSchema = z
  .object({
    seq: z.number().int().positive(),
    ts: z.string().datetime(),
    automationId: z.string().min(1),
    revision: z.number().int().positive(),
    event: automationEventSchema.optional(),
    result: automationLogResultSchema,
    reason: z.string().max(2_000).optional(),
    durationMs: z.number().int().nonnegative().optional(),
    receiptId: z.string().optional(),
    runId: z.string().optional(),
    githubNumber: z.number().int().positive().optional(),
    githubTitle: z.string().max(500).optional(),
    githubUrl: z.string().url().optional(),
    rateLimit: z
      .object({
        bucket: z.enum(['core', 'search']),
        remaining: z.number().int().nonnegative().optional(),
        resetAt: z.string().datetime().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AutomationEvent = z.infer<typeof automationEventSchema>;
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationRuntimeState = z.infer<typeof automationRuntimeStateSchema>;
export type AutomationReceipt = z.infer<typeof automationReceiptSchema>;
export type AutomationLogRecord = z.infer<typeof automationLogRecordSchema>;

/**
 * The two kinds, narrowed (spec 2026-09-14-automations-redesign): the poller and the GitHub
 * scheduler take a `GithubAutomationDefinition` so the poll keys are plain required fields
 * there; the schedule runner takes the other. `superRefine` above guarantees the guards hold
 * for every definition the store hands out.
 */
export type GithubAutomationDefinition = AutomationDefinition & {
  kind: 'github';
  events: AutomationEvent[];
  intervalSeconds: number;
  filters: NonNullable<AutomationDefinition['filters']>;
};
export type ScheduleAutomationDefinition = AutomationDefinition & {
  kind: 'schedule';
  schedule: AutomationSchedule;
};

export function isGithubAutomation(definition: AutomationDefinition): definition is GithubAutomationDefinition {
  return definition.kind === 'github'
    && Array.isArray(definition.events)
    && definition.intervalSeconds !== undefined
    && definition.filters !== undefined;
}

export function isScheduleAutomation(definition: AutomationDefinition): definition is ScheduleAutomationDefinition {
  return definition.kind === 'schedule' && definition.schedule !== undefined;
}
