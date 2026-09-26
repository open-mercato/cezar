import { z } from 'zod';
import { trackerAssociationSchema, trackerFailureSchema } from './tracker.ts';
// An automation launches an ORDINARY cezar task, so the task it carries is the composer's own
// run-creation input minus the keys an automation supplies itself. Consumed rather than
// redeclared — the same one-way direction `./runs.ts` takes towards `./workflows.ts`.
import { createRunInputBaseSchema, runStatusSchema } from './runs.ts';
import { DISPATCH_MAX_SUBTASKS, dispatchKindSchema } from './dispatch.ts';
import { automationScheduleSchema } from './automation-schedule.ts';

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

/** The GitHub activity an automation reacts to. Seven events, all bounded polls — never a webhook. */
export const automationEventSchema = z.enum([
  'pull_request.opened',
  'issue.opened',
  'issue.labeled',
  'issue.unlabeled',
  'pull_request.reviewed',
  'pull_request.review_requested',
  'pull_request.rereview_requested',
]);
export type AutomationEvent = z.infer<typeof automationEventSchema>;

export const trackerAutomationEventSchema = z.enum(['issue.opened', 'issue.status_changed', 'issue.labeled', 'issue.unlabeled']);
export type TrackerAutomationEvent = z.infer<typeof trackerAutomationEventSchema>;
export const trackerTriggerSchema = z.object({
  events: z.array(trackerAutomationEventSchema).min(1).max(4),
  targetStatusIds: z.array(z.string().min(1)).max(100).optional(),
  changedLabelIds: z.array(z.string().min(1)).max(100).optional(),
  /** All exact label names must be present in the polled issue snapshot. */
  requiredLabels: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  association: trackerAssociationSchema,
});
export type TrackerTrigger = z.infer<typeof trackerTriggerSchema>;
export const trackerAutomationOptionsQuerySchema = z.object({ search: z.string().max(200).optional(), cursor: z.string().max(4096).optional() });
export const trackerAutomationOptionsSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(true), association: trackerAssociationSchema,
    events: z.array(trackerAutomationEventSchema), limitations: z.array(z.string()),
    statuses: z.array(z.object({ id: z.string(), name: z.string() })),
    labels: z.array(z.object({ id: z.string(), name: z.string() })), nextCursor: z.string().optional(),
  }), trackerFailureSchema,
]);
export type TrackerAutomationOptions = z.infer<typeof trackerAutomationOptionsSchema>;

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
  /** The GitHub logins a review event must name — the reviewer for `pull_request.reviewed`, the
   *  requested reviewer for the two `review_requested` events. Optional: an empty filter means
   *  "any reviewer". */
  reviewers: z.array(z.string()).optional(),
  status: z.string().optional(),
  lookbackDays: z.number(),
  maxRecords: z.number(),
});
export type AutomationFilters = z.infer<typeof automationFiltersSchema>;

/**
 * What triggers an automation (spec 2026-09-14-automations-redesign): a bounded GitHub poll, a
 * schedule in the cockpit's zone, or a Jira/Linear tracker poll (2026-09-19 discussion). The
 * storage schema defaults a definition without `kind` to `github`, so the wire always carries it.
 *
 * Tracker definitions use trackerTrigger for provider history events and a captured association.
 */
export const automationKindSchema = z.enum(['github', 'schedule', 'tracker']);
export type AutomationKind = z.infer<typeof automationKindSchema>;

/**
 * The automation's own dispatch setting (spec 2026-09-14 Q4): on, with a subtask ceiling, and
 * whether the run is asked to dispatch a final review child. `maxSubtasks` becomes the launched
 * run's `dispatch.intent.maxSubtasks`; `reviewChild` becomes a prompt suffix — the dispatch
 * intent contract gains nothing. Ignored (never refused) on a cockpit with dispatch off.
 */
export const automationDispatchSchema = z.object({
  maxSubtasks: z.number().int().min(1).max(DISPATCH_MAX_SUBTASKS).optional(),
  reviewChild: z.boolean().optional(),
});
export type AutomationDispatch = z.infer<typeof automationDispatchSchema>;

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
    dispatch: automationDispatchSchema.optional(),
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
  kind: automationKindSchema,
  /** `github` kind: always present. `schedule` kind: absent. */
  events: z.array(automationEventSchema).optional(),
  intervalSeconds: z.number().optional(),
  filters: automationFiltersSchema.optional(),
  /** `schedule` kind: always present. `github` kind: absent. */
  trackerTrigger: trackerTriggerSchema.optional(),
  schedule: automationScheduleSchema.optional(),
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
  checkpoint: z.string().optional(),
  frozenHighWatermark: automationCursorSchema.extend({ tieBreaker: z.string() }).optional(),
  backlogAfter: automationCursorSchema.extend({ tieBreaker: z.string() }).optional(),
  nextCheckAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  /** `schedule` kind: the next occurrence's instant and the last fired one's. */
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
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
  // schedule kind (spec 2026-09-14): a Run now launch, a missed occurrence fired once after a
  // gap, occurrences discarded, a launch that threw.
  'manual',
  'catch-up',
  'skipped',
  'failed',
]);
export type AutomationLogResult = z.infer<typeof automationLogResultSchema>;

/** One row of `automation-log.ndjson` — the audit trail the log view renders. */
export const automationLogRecordSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  automationId: z.string(),
  revision: z.number(),
  event: z.union([automationEventSchema, trackerAutomationEventSchema]).optional(),
  result: automationLogResultSchema,
  reason: z.string().optional(),
  durationMs: z.number().optional(),
  receiptId: z.string().optional(),
  runId: z.string().optional(),
  trackerKey: z.string().optional(),
  trackerTitle: z.string().optional(),
  trackerUrl: z.string().optional(),
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
/** The newest launch's run, joined onto the list row (spec 2026-09-14 § API). */
export const automationLastRunSchema = z.object({
  runId: z.string(),
  status: runStatusSchema,
  /** When the log recorded the launch. */
  ts: z.string(),
  costUsd: z.number().optional(),
});
export type AutomationLastRun = z.infer<typeof automationLastRunSchema>;

export const automationListEntrySchema = automationDefinitionSchema.extend({
  state: automationRuntimeStateSchema.optional(),
  latestLog: automationLogRecordSchema.optional(),
  counts: automationCountsSchema,
  /** When it fires next: `state.nextRunAt` for a schedule, `state.nextCheckAt` for a poll;
   *  absent while paused or never armed. */
  nextRunAt: z.string().optional(),
  lastRun: automationLastRunSchema.optional(),
  /** Launches in the last 7 × 24 h, from the log. */
  runs7d: z.number(),
  /** Spend of the runs launched in the last 7 × 24 h; absent when `capabilities.costMetrics` is off. */
  costUsd7d: z.number().optional(),
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
/** The list header's "this week" strip: Monday 00:00 in `timeZone` → now. */
export const automationStatsSchema = z.object({
  runs: z.number(),
  failed: z.number(),
  agentSeconds: z.number(),
  /** Absent when `capabilities.costMetrics` is off. */
  costUsd: z.number().optional(),
});
export type AutomationStats = z.infer<typeof automationStatsSchema>;

export const automationsResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  scheduler: z.object({
    state: z.enum(['scheduled', 'idle']),
    nextDue: z.string().optional(),
  }),
  /** The server's IANA zone — what every schedule is evaluated in and every time is shown in. */
  timeZone: z.string(),
  stats: automationStatsSchema,
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
/** A run the log links to, with the dispatch children under it (spec 2026-09-14 § API). */
export const automationLogRunSchema = z.object({
  title: z.string(),
  status: runStatusSchema,
  costUsd: z.number().optional(),
  children: z.array(z.object({
    runId: z.string(),
    kind: dispatchKindSchema.optional(),
    title: z.string(),
    status: runStatusSchema,
    costUsd: z.number().optional(),
  })),
});
export type AutomationLogRun = z.infer<typeof automationLogRunSchema>;

export const automationLogResponseSchema = z.object({
  records: z.array(automationLogRecordSchema),
  /** Keyed by every `runId` the records name. */
  runs: z.record(z.string(), automationLogRunSchema),
});
export type AutomationLogResponse = z.infer<typeof automationLogResponseSchema>;

/** `POST /automation-log/:receiptId/retry` (202) — the relaunched receipt and its new run. */
export const automationRetryResponseSchema = z.object({
  receiptId: z.string(),
  runId: z.string(),
});
export type AutomationRetryResponse = z.infer<typeof automationRetryResponseSchema>;

/** `POST /automations/:id/run` (202) — a schedule automation fired now, by hand. */
export const automationRunResponseSchema = z.object({ runId: z.string() });
export type AutomationRunResponse = z.infer<typeof automationRunResponseSchema>;

/**
 * `GET /workspace/automation-templates` — the other registered projects' automations, as the
 * editor's "From your other projects" palette lists them (spec 2026-09-14 Q7). Read-only.
 */
export const automationTemplateSchema = z.object({
  project: z.object({ id: z.string(), name: z.string() }),
  id: z.string(),
  name: z.string(),
  /** Not `automationKindSchema`: a template is only ever used to PRE-FILL the create form, which
   *  does not accept `tracker` (2026-09-19) — see `createAutomationInputSchema`. The server never
   *  offers a tracker automation as a template (`automationTemplatesOf` skips it). */
  kind: z.enum(['github', 'schedule']),
  trackerTrigger: trackerTriggerSchema.optional(),
  schedule: automationScheduleSchema.optional(),
  events: z.array(automationEventSchema).optional(),
  intervalSeconds: z.number().optional(),
  task: z.object({
    prompt: z.string(),
    workflow: z.string().optional(),
    runner: z.string().optional(),
    model: z.string().optional(),
    autonomous: z.boolean().optional(),
    dispatch: automationDispatchSchema.optional(),
  }),
});
export type AutomationTemplate = z.infer<typeof automationTemplateSchema>;

export const automationTemplatesResponseSchema = z.object({
  templates: z.array(automationTemplateSchema),
});
export type AutomationTemplatesResponse = z.infer<typeof automationTemplatesResponseSchema>;

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
  .omit({ id: true, revision: true, createdAt: true, updatedAt: true, enabled: true, kind: true })
  .extend({
    /** Omitted = `github`, the shape every pre-schedule client sends. */
    kind: automationKindSchema.optional(),
    enable: z.boolean().optional(),
  });
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
