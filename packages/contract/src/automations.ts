import { z } from 'zod';
// An automation launches an ORDINARY cezar task, so the task it carries is the composer's own
// run-creation input minus the keys an automation supplies itself. Consumed rather than
// redeclared — the same one-way direction `./runs.ts` takes towards `./workflows.ts`.
import { createRunInputBaseSchema } from './runs.ts';

/**
 * The AUTOMATIONS family of `/api/v1` (#694) — the per-project GitHub triggers, their runtime
 * state, the manual "test filter" checks and the execution log.
 *
 * These shapes exist twice on purpose and only once as a DEFINITION of what the wire carries.
 * `packages/cezar/src/automations/types.ts` owns the STORAGE schemas: they are `.passthrough()`,
 * because a definitions/state/log file written by a newer cezar must survive a round trip through
 * an older one rather than lose keys it has never heard of. The schemas here are the CLOSED wire
 * half of those files — every key the routes actually answer with, and no index signature, so a
 * consumer compiles against a shape rather than against `unknown`. `src/server/
 * contract-parity.automations.test.ts` checks each response schema against the route that serves
 * it, in both directions.
 *
 * What that guard can and cannot see is worth knowing: a named key whose type drifts fails, and a
 * key this file makes required that the route does not send fails — but an EXTRA key arriving
 * through the storage schemas' catchall cannot, since the route's own type admits any key. That is
 * the same limit `contract-parity.workspace.test.ts` documents for the open GUI-pref bags.
 */

// ---- the definition ------------------------------------------------------------------------

/** The GitHub activity an automation reacts to. Four events, all bounded polls — never a webhook. */
export const automationEventSchema = z.enum([
  'pull_request.opened',
  'issue.opened',
  'issue.labeled',
  'issue.unlabeled',
]);
export type AutomationEvent = z.infer<typeof automationEventSchema>;

/**
 * The bounded candidate filter.
 *
 * `lookbackDays` and `maxRecords` are REQUIRED here although the storage schema defaults them: a
 * default fills on PARSE, so both keys are always present in what the server hands out — and a
 * caller that omits them in a request body still gets them back materialized.
 */
export const automationFiltersSchema = z.object({
  authors: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  allLabels: z.array(z.string()).optional(),
  anyLabels: z.array(z.string()).optional(),
  excludeLabels: z.array(z.string()).optional(),
  /** Required for the two label events — the server rejects a definition without it. */
  changedLabels: z.array(z.string()).optional(),
  lookbackDays: z.number(),
  maxRecords: z.number(),
});
export type AutomationFilters = z.infer<typeof automationFiltersSchema>;

/**
 * The task a match launches: `POST /runs`' own body minus the three keys an automation owns
 * itself — `task` (the rendered prompt), `images` and `todoId` — plus the prompt TEMPLATE.
 *
 * Two keys are re-spelled rather than inherited, because the automation schema really does differ
 * from the composer's and the contract has to describe the automation route:
 *
 *  - `variants` is the literal union the server's own automation schema accepts (`1 | 2 | 3`),
 *    not the composer's `z.number().int().min(1).max(3)`. Identical values, but only the literal
 *    spelling is assignable to the route's parameter;
 *  - `systemPrompt` carries no `.transform()` here. The composer's trims-to-absent on the way in,
 *    which makes the key REQUIRED (`string | undefined`) on the output side; the automation route
 *    stores and answers it plainly, so it stays optional.
 */
export const automationTaskSchema = createRunInputBaseSchema
  .omit({ task: true, images: true, todoId: true, systemPrompt: true })
  .extend({
    /** The prompt template. `{{github.number}}`, `{{github.title}}`, `{{github.url}}` and
     *  `{{github.labels}}` are substituted per match; GitHub content is appended as untrusted
     *  context, never interpolated into instructions. */
    prompt: z.string(),
    variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    systemPrompt: z.string().optional(),
  });
export type AutomationTask = z.infer<typeof automationTaskSchema>;

/** One stored automation, as every route that answers a single definition serves it. */
export const automationDefinitionSchema = z.object({
  id: z.string(),
  /** Bumped on every edit; a PUT must echo the revision it read (optimistic concurrency). */
  revision: z.number(),
  name: z.string(),
  description: z.string().optional(),
  /** Always present: the storage schema defaults it to `false`, so a definition is created
   *  PAUSED and enabling it is a separate, baseline-establishing act. */
  enabled: z.boolean(),
  events: z.array(automationEventSchema),
  intervalSeconds: z.number(),
  filters: automationFiltersSchema,
  task: automationTaskSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

// ---- runtime state and the execution log ---------------------------------------------------

/** Where the poller had got to: an ISO timestamp plus a tie-breaker for same-second records. */
export const automationCursorSchema = z.object({
  timestamp: z.string(),
  tieBreaker: z.string().optional(),
});
export type AutomationCursor = z.infer<typeof automationCursorSchema>;

/**
 * The scheduler's own bookkeeping for one automation. Every key is optional — a definition that
 * has never run has no state at all, and the keys appear as the poller reaches each stage.
 */
export const automationRuntimeStateSchema = z.object({
  /** The definition revision this state belongs to; a bumped revision re-baselines. */
  revision: z.number().optional(),
  /** Enabling establishes a CURRENT-TIME baseline: records older than this never launch. */
  baselineAt: z.string().optional(),
  cursor: automationCursorSchema.optional(),
  frozenHighWatermark: automationCursorSchema.extend({ tieBreaker: z.string() }).optional(),
  backlogAfter: automationCursorSchema.extend({ tieBreaker: z.string() }).optional(),
  nextCheckAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  /** Per-query GitHub ETags, so an unchanged page costs no rate-limit budget. */
  etags: z.record(z.string(), z.string()).optional(),
  backoffUntil: z.string().optional(),
  consecutiveFailures: z.number().optional(),
});
export type AutomationRuntimeState = z.infer<typeof automationRuntimeStateSchema>;

/** What one poll decided about one candidate. `baseline` and `preview` are bookkeeping rows: no
 *  task was launched and none was meant to be. */
export const automationLogResultSchema = z.enum([
  'launched',
  'no-match',
  'duplicate',
  'rate-limited',
  'error',
  'baseline',
  'preview',
]);
export type AutomationLogResult = z.infer<typeof automationLogResultSchema>;

/** One row of `automation-log.ndjson` — the audit trail the log view renders. */
export const automationLogRecordSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  automationId: z.string(),
  revision: z.number(),
  event: automationEventSchema.optional(),
  result: automationLogResultSchema,
  reason: z.string().optional(),
  durationMs: z.number().optional(),
  receiptId: z.string().optional(),
  runId: z.string().optional(),
  githubNumber: z.number().optional(),
  githubTitle: z.string().optional(),
  githubUrl: z.string().optional(),
  rateLimit: z
    .object({
      bucket: z.enum(['core', 'search']),
      remaining: z.number().optional(),
      resetAt: z.string().optional(),
    })
    .optional(),
});
export type AutomationLogRecord = z.infer<typeof automationLogRecordSchema>;

// ---- responses -----------------------------------------------------------------------------

/** The list view's per-automation tallies, counted over that automation's last 100 log rows. */
export const automationCountsSchema = z.object({
  matches: z.number(),
  launched: z.number(),
  duplicates: z.number(),
  errors: z.number(),
});
export type AutomationCounts = z.infer<typeof automationCountsSchema>;

/** One row of `GET /automations`: the definition plus everything the list renders beside it. */
export const automationListEntrySchema = automationDefinitionSchema.extend({
  state: automationRuntimeStateSchema.optional(),
  latestLog: automationLogRecordSchema.optional(),
  counts: automationCountsSchema,
});
export type AutomationListEntry = z.infer<typeof automationListEntrySchema>;

/**
 * `GET /automations` — the whole page in one read.
 *
 * `available`/`reason` are the forge's own cached availability (the same degrade `/github` uses:
 * no GitHub remote, no `gh`, offline — never a 5xx), and `scheduler` summarizes the timer:
 * `scheduled` when any definition is enabled, `idle` otherwise, with `nextDue` the earliest
 * pending check across them.
 */
export const automationsResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  scheduler: z.object({
    state: z.enum(['scheduled', 'idle']),
    nextDue: z.string().optional(),
  }),
  automations: z.array(automationListEntrySchema),
});
export type AutomationsResponse = z.infer<typeof automationsResponseSchema>;

/** `POST /automations` (201), `PUT /automations/:id`, `POST /automations/:id/{enable,pause}`. */
export const automationResponseSchema = z.object({ automation: automationDefinitionSchema });
export type AutomationResponse = z.infer<typeof automationResponseSchema>;

/** `GET /automations/:id` — one definition with its state and the most recent log row. */
export const automationDetailResponseSchema = z.object({
  automation: automationDefinitionSchema,
  state: automationRuntimeStateSchema.optional(),
  latestLog: automationLogRecordSchema.optional(),
});
export type AutomationDetailResponse = z.infer<typeof automationDetailResponseSchema>;

/**
 * One manual "test filter" check (`GET /automation-checks/:checkId`).
 *
 * Server-memory only, keyed by an unguessable id and capped at 200 — it is the progress record of
 * an asynchronous poll, not stored state, which is why it survives no restart and appears in no
 * file. `preview` counts matches and launches nothing; `execute` launches exactly as a scheduled
 * poll would.
 */
export const automationCheckSchema = z.object({
  id: z.string(),
  automationId: z.string(),
  mode: z.enum(['preview', 'execute']),
  status: z.enum(['queued', 'running', 'complete', 'error']),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  matches: z.number().optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
});
export type AutomationCheck = z.infer<typeof automationCheckSchema>;

/** `POST /automations/:id/check` (202) — the check runs in the background; poll the id. */
export const automationCheckQueuedResponseSchema = z.object({ checkId: z.string() });
export type AutomationCheckQueuedResponse = z.infer<typeof automationCheckQueuedResponseSchema>;

/** `GET /automation-log` — newest first, capped at 100 rows per read. */
export const automationLogResponseSchema = z.object({
  records: z.array(automationLogRecordSchema),
});
export type AutomationLogResponse = z.infer<typeof automationLogResponseSchema>;

/** `POST /automation-log/:receiptId/retry` (202) — the relaunched receipt and its new run. */
export const automationRetryResponseSchema = z.object({
  receiptId: z.string(),
  runId: z.string(),
});
export type AutomationRetryResponse = z.infer<typeof automationRetryResponseSchema>;

// ---- request bodies ------------------------------------------------------------------------
//
// `z.input`, like every other request type in this package: a caller writes what the schema
// ACCEPTS. Nothing here transforms today, but the convention is what keeps that true if one ever
// does.

/**
 * `POST /automations`. The definition minus everything the server owns — id, revision, the
 * timestamps and `enabled`, which is not a body field: a definition is always created paused, and
 * `enable: true` asks the route to enable it AND establish a current-time baseline in one step.
 */
export const createAutomationInputSchema = automationDefinitionSchema
  .omit({ id: true, revision: true, createdAt: true, updatedAt: true, enabled: true })
  .extend({ enable: z.boolean().optional() });
export type CreateAutomationInput = z.input<typeof createAutomationInputSchema>;

/**
 * `PUT /automations/:id`. The same body plus the revision the editor read — a stale one answers
 * 409 rather than overwriting somebody else's edit. `enabled` IS a field here: an edit may not
 * silently pause a running automation, so the caller restates it.
 */
export const updateAutomationInputSchema = createAutomationInputSchema
  .omit({ enable: true })
  .extend({
    enabled: z.boolean().optional(),
    expectedRevision: z.number(),
  });
export type UpdateAutomationInput = z.input<typeof updateAutomationInputSchema>;

/** `POST /automations/:id/check` — which of the two manual checks to run. */
export const automationCheckInputSchema = z.object({
  mode: z.enum(['preview', 'execute']),
});
export type AutomationCheckInput = z.input<typeof automationCheckInputSchema>;
