import { z } from 'zod';
// A postponed task launches an ORDINARY cezar task, so the task it carries is the composer's own
// run-creation input minus the keys a scheduled definition owns itself (`task` becomes `prompt`,
// browser-only `images` and inbox `todoId` are dropped). Consumed rather than redeclared — the
// same one-way direction `./automations.ts` takes towards `./runs.ts`.
import { createRunInputBaseSchema } from './runs.ts';

/**
 * The SCHEDULED-TASKS family of `/api/v1` (spec 2026-08-01-postponed-tasks) — one-time postponed
 * tasks, their runtime state and their occurrence history.
 *
 * As with `./automations.ts`, these shapes are the CLOSED wire half of the `.passthrough()`
 * storage schemas in `packages/cezar/src/scheduled-tasks/types.ts`. `src/server/
 * contract-parity.scheduled-tasks.test.ts` checks each response schema against the route that
 * serves it, in both directions. Recurrence adds a new `timing` union member and calculation
 * policy without replacing any shape here — see `2026-08-01-recurring-tasks.md`.
 */

// ---- the definition ------------------------------------------------------------------------

/**
 * The task a due occurrence launches: `POST /runs`' own body minus the three keys a scheduled
 * definition owns itself — `task` (renamed to the stored `prompt`), `images` (browser-only, not
 * retained in v1) and `todoId` (inbox provenance) — plus the prompt.
 */
export const scheduledTaskTemplateSchema = createRunInputBaseSchema
  .omit({ task: true, images: true, todoId: true, systemPrompt: true })
  .extend({
    /** The task prompt. Stored verbatim; no placeholder substitution (unlike automations). */
    prompt: z.string(),
    // Re-spelled to match the server's own storage schema exactly, the same way `./automations.ts`
    // does: `variants` is the literal union the store accepts, and `systemPrompt` carries no
    // `.transform()` so it stays optional rather than required on the output side.
    variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    systemPrompt: z.string().optional(),
  });
export type ScheduledTaskTemplate = z.infer<typeof scheduledTaskTemplateSchema>;

/** The version-1 timing discriminant: a single absolute instant plus the IANA zone it was chosen
 *  in, so the cockpit can render the exact local wall-clock time the user picked. */
export const scheduledTaskTimingSchema = z.object({
  kind: z.literal('once'),
  /** The authoritative UTC instant this task is due (ISO-8601). */
  at: z.string(),
  /** The IANA identifier the local time was chosen in (e.g. `America/New_York`). */
  timezone: z.string(),
});
export type ScheduledTaskTiming = z.infer<typeof scheduledTaskTimingSchema>;

/** One stored scheduled task, as every route that answers a single definition serves it. */
export const scheduledTaskDefinitionSchema = z.object({
  id: z.string(),
  /** Bumped on every edit; a PUT must echo the revision it read (optimistic concurrency). */
  revision: z.number(),
  name: z.string(),
  description: z.string().optional(),
  /** A paused definition never launches. Created enabled unless the composer paused it. */
  enabled: z.boolean(),
  timing: scheduledTaskTimingSchema,
  task: scheduledTaskTemplateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledTaskDefinition = z.infer<typeof scheduledTaskDefinitionSchema>;

// ---- runtime state and occurrence history --------------------------------------------------

/** The lifecycle status the coordinator records for one definition. `overdue` is DERIVED (a
 *  `pending` definition whose instant has passed) and appears only in responses, never on disk. */
export const scheduledTaskStatusSchema = z.enum([
  'pending',
  'paused',
  'launching',
  'completed',
  'error',
]);
export type ScheduledTaskStatus = z.infer<typeof scheduledTaskStatusSchema>;

/** The display status a list/detail row shows — the stored status plus the derived `overdue`. */
export const scheduledTaskDisplayStatusSchema = z.enum([
  'pending',
  'overdue',
  'paused',
  'launching',
  'completed',
  'error',
]);
export type ScheduledTaskDisplayStatus = z.infer<typeof scheduledTaskDisplayStatusSchema>;

/** The coordinator's bookkeeping for one definition. Every key is optional — a definition that
 *  has never been observed has no state at all. */
export const scheduledTaskRuntimeStateSchema = z.object({
  revision: z.number().optional(),
  status: scheduledTaskStatusSchema.optional(),
  nextDueAt: z.string().optional(),
  lastOccurrenceId: z.string().optional(),
  lastRunId: z.string().optional(),
  lastObservedAt: z.string().optional(),
  consecutiveFailures: z.number().optional(),
});
export type ScheduledTaskRuntimeState = z.infer<typeof scheduledTaskRuntimeStateSchema>;

/** How a due occurrence resolved. `config-error` launched nothing (missing workflow/skill etc.)
 *  and leaves the definition overdue; `launch-error` reserved but crashed before a run existed. */
export const scheduledTaskOccurrenceStatusSchema = z.enum([
  'reserved',
  'launched',
  'launch-error',
  'config-error',
]);
export type ScheduledTaskOccurrenceStatus = z.infer<typeof scheduledTaskOccurrenceStatusSchema>;

export const scheduledTaskTriggerSchema = z.enum(['scheduled', 'manual']);
export type ScheduledTaskTrigger = z.infer<typeof scheduledTaskTriggerSchema>;

/** One row of `scheduled-task-occurrences.ndjson` — never stores prompt text or credentials. */
export const scheduledTaskOccurrenceSchema = z.object({
  seq: z.number(),
  occurrenceId: z.string(),
  occurrenceKey: z.string(),
  scheduledTaskId: z.string(),
  revision: z.number(),
  scheduledFor: z.string(),
  observedAt: z.string(),
  trigger: scheduledTaskTriggerSchema,
  status: scheduledTaskOccurrenceStatusSchema,
  reason: z.string().optional(),
  runId: z.string().optional(),
  groupId: z.string().optional(),
  updatedAt: z.string(),
});
export type ScheduledTaskOccurrence = z.infer<typeof scheduledTaskOccurrenceSchema>;

// ---- responses -----------------------------------------------------------------------------

/** One row of `GET /scheduled-tasks`: the definition plus everything the list renders beside it. */
export const scheduledTaskListEntrySchema = scheduledTaskDefinitionSchema.extend({
  displayStatus: scheduledTaskDisplayStatusSchema,
  state: scheduledTaskRuntimeStateSchema.optional(),
  latestOccurrence: scheduledTaskOccurrenceSchema.optional(),
});
export type ScheduledTaskListEntry = z.infer<typeof scheduledTaskListEntrySchema>;

/** `GET /scheduled-tasks` — the whole page in one read. */
export const scheduledTasksResponseSchema = z.object({
  scheduler: z.object({
    state: z.enum(['scheduled', 'idle']),
    nextDue: z.string().optional(),
  }),
  writable: z.boolean(),
  scheduledTasks: z.array(scheduledTaskListEntrySchema),
});
export type ScheduledTasksResponse = z.infer<typeof scheduledTasksResponseSchema>;

/** `POST /scheduled-tasks` (201), `PUT /scheduled-tasks/:id`. */
export const scheduledTaskResponseSchema = z.object({
  scheduledTask: scheduledTaskDefinitionSchema,
  state: scheduledTaskRuntimeStateSchema.optional(),
});
export type ScheduledTaskResponse = z.infer<typeof scheduledTaskResponseSchema>;

/** `GET /scheduled-tasks/:id` — one definition with its state and latest occurrence. */
export const scheduledTaskDetailResponseSchema = z.object({
  scheduledTask: scheduledTaskDefinitionSchema,
  displayStatus: scheduledTaskDisplayStatusSchema,
  state: scheduledTaskRuntimeStateSchema.optional(),
  latestOccurrence: scheduledTaskOccurrenceSchema.optional(),
});
export type ScheduledTaskDetailResponse = z.infer<typeof scheduledTaskDetailResponseSchema>;

/** `POST /scheduled-tasks/:id/run-now` (202). */
export const scheduledTaskRunNowResponseSchema = z.object({
  occurrenceId: z.string(),
  runId: z.string().optional(),
});
export type ScheduledTaskRunNowResponse = z.infer<typeof scheduledTaskRunNowResponseSchema>;

/** `POST /scheduled-tasks/preview` — the authoritative local/UTC rendering plus soft warnings. */
export const scheduledTaskPreviewResponseSchema = z.object({
  at: z.string(),
  timezone: z.string(),
  localLabel: z.string(),
  utcLabel: z.string(),
  warnings: z.array(z.string()),
});
export type ScheduledTaskPreviewResponse = z.infer<typeof scheduledTaskPreviewResponseSchema>;

/** `GET /scheduled-task-occurrences` — newest first, capped at 100 rows per read. */
export const scheduledTaskOccurrencesResponseSchema = z.object({
  occurrences: z.array(scheduledTaskOccurrenceSchema),
});
export type ScheduledTaskOccurrencesResponse = z.infer<typeof scheduledTaskOccurrencesResponseSchema>;

/** `POST /scheduled-task-occurrences/:occurrenceId/retry` (202). */
export const scheduledTaskRetryResponseSchema = z.object({
  occurrenceId: z.string(),
  runId: z.string().optional(),
});
export type ScheduledTaskRetryResponse = z.infer<typeof scheduledTaskRetryResponseSchema>;

// ---- request bodies ------------------------------------------------------------------------

/** The timing a composer submits: a naive local wall-clock (`YYYY-MM-DDTHH:mm[:ss]`) plus its
 *  IANA zone. The server computes the authoritative `at` instant from these two. */
export const scheduledTaskTimingInputSchema = z.object({
  kind: z.literal('once'),
  localAt: z.string(),
  timezone: z.string(),
});
export type ScheduledTaskTimingInput = z.input<typeof scheduledTaskTimingInputSchema>;

/**
 * `POST /scheduled-tasks`. The definition minus everything the server owns — id, revision and the
 * timestamps — with the composer's local timing rather than the stored instant.
 */
export const createScheduledTaskInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  timing: scheduledTaskTimingInputSchema,
  task: scheduledTaskTemplateSchema,
});
export type CreateScheduledTaskInput = z.input<typeof createScheduledTaskInputSchema>;

/** `PUT /scheduled-tasks/:id`. The same body plus the revision the editor read — a stale one
 *  answers 409 rather than overwriting a concurrent edit. */
export const updateScheduledTaskInputSchema = createScheduledTaskInputSchema.extend({
  expectedRevision: z.number(),
});
export type UpdateScheduledTaskInput = z.input<typeof updateScheduledTaskInputSchema>;

/** `POST /scheduled-tasks/preview`. */
export const scheduledTaskPreviewInputSchema = z.object({
  localAt: z.string(),
  timezone: z.string(),
});
export type ScheduledTaskPreviewInput = z.input<typeof scheduledTaskPreviewInputSchema>;
