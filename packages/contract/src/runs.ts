import { z } from 'zod';
import { runnerSchema } from './health.ts';
// The chain shapes belong to the workflows family; the run record embeds one, so this file
// consumes them rather than redeclaring. One-way on purpose — see the header of `./workflows.ts`.
import { workflowDefSchema, workflowStepDefSchema } from './workflows.ts';

/**
 * The RUNS family of `/api/v1` — a task's record, its lifecycle mutations, and the artifacts
 * (queued prompt stack, commits, git actions) that hang off one run.
 *
 * The record itself is persisted by `src/runs/store.ts`, so these schemas describe a shape that
 * already has a zod definition server-side; they are the WIRE half of it, and the parity guard in
 * `src/server/contract-parity.runs.test.ts` is what keeps the two from drifting.
 *
 * Two things about the mutation responses are deliberate and were measured, not assumed:
 *
 *  - every "did it work" flag is a `z.literal(true)`, not a boolean. Each of those routes answers
 *    409 (or 404) on refusal, so `false` is not a value the 200 branch can carry — the
 *    hand-written DTO's `boolean` invited a re-check the server never needs. `cancelled` is the
 *    one real boolean: `POST /runs/:id/cancel` answers 200 either way.
 *  - `POST /runs/:id/messages` answers a three-way UNION, not one object with three optional
 *    keys. The client narrows on which key is present, and the DTO's flattened shape allowed
 *    `{}` — a payload the route cannot produce.
 */

// ---- the record --------------------------------------------------------------------------

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * Sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490): the agent ended its
 * turn still working on its own downstream work (a sub-agent, a monitored command) and said so
 * with the `CEZ:MONITORING` marker — a non-attention state, not "needs you".
 */
export const runActivitySchema = z.enum(['monitoring']);
export type RunActivity = z.infer<typeof runActivitySchema>;

export const stepStatusSchema = z.enum([
  'pending',
  'running',
  'waiting',
  'review',
  'done',
  'failed',
  'cancelled',
  'skipped',
]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

/** One step of a run's chain. */
export const stepStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'check']),
  status: stepStatusSchema,
  iterations: z.number(),
  tokensUsed: z.number(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Latest agent session id — `claude --resume <id>` and friends. */
  sessionId: z.string().optional(),
  /** Backend that owns `sessionId`; absent on records written before backend affinity. */
  backend: runnerSchema.optional(),
  costUsd: z.number().optional(),
});
export type StepState = z.infer<typeof stepStateSchema>;

/** Aggregate diff numbers of a run's worktree vs its base (#389). */
export const diffStatSchema = z.object({
  adds: z.number(),
  dels: z.number(),
  files: z.number(),
});
export type DiffStat = z.infer<typeof diffStatSchema>;

/** One prompt message stacked onto a run while it waits for a free agent slot (#472). */
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** `/api/v1/runs/:id/images/…` URLs — attachments are persisted, never inlined. */
  images: z.array(z.string()).optional(),
  createdAt: z.string(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

/** One aggregated sample of a run's live process tree (`src/core/process-usage.ts`). */
export const processUsageSchema = z.object({
  /** Sum of `%cpu` across the tree — can exceed 100 on multi-core work. */
  cpuPct: z.number(),
  rssBytes: z.number(),
  procCount: z.number(),
});
export type ProcessUsage = z.infer<typeof processUsageSchema>;

/**
 * The stored run record, as `runs.json` holds it (`src/runs/store.ts`).
 *
 * `archived` is required although the store schema defaults it: a default fills on PARSE, so the
 * key is always present in what the server hands out. Everything else optional here is optional
 * there — these are additive fields, and an absent one means "this run predates it".
 */
export const runRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Display title (#389): auto-derived from the first agent turn, or the user's inline edit
   *  (`PATCH /runs/:id` sets it together with `title`). Show `titleSummary ?? title`. */
  titleSummary: z.string().optional(),
  /** Refreshed on every turn-end; absent until the first turn ends (and on worktree-less runs). */
  diffStat: diffStatSchema.optional(),
  workflow: z.string(),
  task: z.string(),
  /** Prompt messages stacked onto the run while it waited for a free agent slot (#472). Folded
   *  into the prompt at dequeue — never delivered as their own turns. Absent on pre-#472 runs. */
  queuedMessages: z.array(queuedMessageSchema).optional(),
  /** URLs of images attached to the initial task prompt (#image-display). */
  taskImages: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Normalized provider/model identity used for attribution and reproducible replay. */
  modelIdentity: z.string().optional(),
  runner: runnerSchema.optional(),
  /** Echo of the extra system prompt the run used (POST override or config default). */
  systemPrompt: z.string().optional(),
  /** false when the run deliberately disabled follow-up todo generation. Absent means enabled. */
  generateFollowups: z.boolean().optional(),
  /** Autonomous mode (#autonomous): the run never parks at `waiting` or the terminal `review`
   *  gate. Absent = falsy = not autonomous. */
  autonomous: z.boolean().optional(),
  /**
   * Provenance for a task a project GitHub automation launched (#694). Absent on every ordinary
   * run, which is what makes it additive — the cockpit shows the "from automation" link only when
   * it is there.
   *
   * `event` is a plain string rather than `automationEventSchema`: it is the event NAME the
   * launching definition matched, recorded on the run for the audit trail, and `src/runs/store.ts`
   * persists it as free text so an older cezar can still read a record written by a newer one.
   */
  automation: z
    .object({
      automationId: z.string(),
      automationRevision: z.number(),
      receiptId: z.string(),
      event: z.string(),
      githubUrl: z.string(),
    })
    .optional(),
  status: runStatusSchema,
  /** `monitoring` while `status === 'running'` and the agent is working on downstream work.
   *  Absent on old runs; cleared on resume/end. */
  activity: runActivitySchema.optional(),
  /** Exact ISO-8601 deadline for the next automatic monitoring check. */
  monitoringWakeAt: z.string().optional(),
  /** The current live monitoring epoch exhausted its 40 automatic checks. */
  monitoringWakeCapReached: z.boolean().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  costUsd: z.number().optional(),
  pullRequestUrl: z.string().optional(),
  /** The PR this task is ABOUT (#407) — auto-discovered from conversation references. Display
   *  tier only: `pullRequestUrl` (the PR this task CREATED) wins, and the action gates ignore it. */
  referencedPullRequestUrl: z.string().optional(),
  /** The PR/issue number this task is ABOUT (task auto-naming spec) — display tier only. */
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  /** Server-side provenance: referenced-issue discovery currently owns `issueNumber`. */
  referencedIssueNumberSeeded: z.boolean().optional(),
  /** 'user' = renamed via PATCH, never auto-overwritten; 'marker' = agent-declared via
   *  CEZ:TITLE (spec 2026-07-18-task-ref-markers); 'auto' = namer-owned. */
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  /** References the agent declared via CEZ:PR/CEZ:ISSUE markers — authoritative over the namer
   *  for the matching kind. */
  markerRefs: z.object({ pr: z.number().optional(), issue: z.number().optional() }).optional(),
  /** The referenced tier's working set (distinct PR URLs spotted, capped server-side). */
  referencedPrCandidates: z.array(z.string()).optional(),
  /** The issue this task is ABOUT (spec 2026-07-21-report-ref-discovery). Display-only. */
  referencedIssueUrl: z.string().optional(),
  /** The referenced-issue working set, persisted like `referencedPrCandidates`. Capped. */
  referencedIssueCandidates: z.array(z.string()).optional(),
  /** Absent when the run executed in the repo working tree rather than its own worktree. */
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  /** Set when count-based retention (#483) reclaimed the worktree DIRECTORY (the branch is
   *  kept): the dir is gone but recoverable. */
  worktreeReclaimedAt: z.string().optional(),
  /** Parallel variants (spec 010): runs sharing a groupId are one group. */
  groupId: z.string().optional(),
  /** Variant letter within the group — 'A' | 'B' | 'C'. */
  variant: z.string().optional(),
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  archived: z.boolean(),
  archivedAt: z.string().optional(),
  currentStepId: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(stepStateSchema),
  /**
   * The persisted workflow definition, so a `queued` run survives a restart — including the ad-hoc
   * "(planned)" chains that exist nowhere else.
   *
   * The definition schema and NOT `z.record(z.string(), z.unknown())`: this key comes off the wire,
   * so its values are whatever `JSON.parse` can produce and nothing else. `unknown` was wider than
   * the server can serialize, and it made the route type unrepresentable here — hono maps `unknown`
   * to its own `JSONValue`, whose index signature admits `object | symbol | undefined`. The fix was
   * at the source: `src/runs/store.ts` persists a typed `workflowDefSchema` now, so the route's own
   * type is this shape and the two-way check in `src/server/contract-parity.runs.test.ts` covers it
   * like every other key.
   */
  workflowDef: workflowDefSchema.optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/**
 * What `GET /runs` and `GET /runs/:id` answer: the stored record plus the live `usage` sample the
 * server attaches on the way out (`withUsage`). Absent for finished runs and wherever `ps` yields
 * nothing — never persisted, and never attached by the mutation routes.
 */
export const apiRunSchema = runRecordSchema.extend({
  usage: processUsageSchema.optional(),
});
export type ApiRun = z.infer<typeof apiRunSchema>;

// ---- mutation responses ------------------------------------------------------------------

/**
 * `POST /runs` (201) — one record for ×1, a group for ×2/×3.
 *
 * The ×1 branch is the STORED record, not `ApiRun`: `startRun` answers before any `ps` sample
 * exists, so the create route never runs a record through `withUsage`.
 */
export const createRunResponseSchema = z.union([
  runRecordSchema,
  z.object({ runs: z.array(runRecordSchema) }),
]);
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

/** `POST /runs/:id/cancel` — genuinely a boolean: an already-settled run answers 200 + `false`. */
export const cancelResponseSchema = z.object({ cancelled: z.boolean() });
export type CancelResponse = z.infer<typeof cancelResponseSchema>;

/** `POST /runs/archive-finished` — how many runs the sweep archived. */
export const archiveFinishedResponseSchema = z.object({ archived: z.number() });
export type ArchiveFinishedResponse = z.infer<typeof archiveFinishedResponseSchema>;

/** `DELETE /runs/:id` — an active run is a 409 and an unknown one a 404, so this only ever
 *  reports success. */
export const deleteRunResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteRunResponse = z.infer<typeof deleteRunResponseSchema>;

/** `POST /runs/:id/finish` — "no open session" is a 409. */
export const finishResponseSchema = z.object({ finished: z.literal(true) });
export type FinishResponse = z.infer<typeof finishResponseSchema>;

/** `POST /runs/:id/continue` — a refusal to reopen is a 409 carrying the engine's reason. */
export const continueResponseSchema = z.object({ continued: z.literal(true) });
export type ContinueResponse = z.infer<typeof continueResponseSchema>;

/**
 * `POST /runs/:id/pr` (201, spec 009) — the draft PR's URL; `dryRun` marks the CEZ_DRY_RUN fake
 * (no push, no gh). Failure is a 409 whose `ApiError` carries the `manual` merge command instead.
 *
 * `dryRun` is REQUIRED: `createDraftPr`'s success outcome always sets it (`forge/types.ts`), so
 * the key is always on the wire. The hand-written DTO had it optional.
 */
export const createPrResponseSchema = z.object({
  url: z.string(),
  dryRun: z.boolean(),
});
export type CreatePrResponse = z.infer<typeof createPrResponseSchema>;

/**
 * `POST /runs/:id/messages` — one of three shapes (#472), by how far the run has got:
 * `delivered` (a live session took it), `queued` (still waiting for a slot, so it was stacked
 * onto the prompt and the stored entry rides along), `deferred` (mid-spawn, so it was buffered
 * and arrives as an ordinary follow-up turn once the session opens). Anything else is a 409.
 *
 * A union, not one object of optional flags: exactly one of the three keys is ever present, and
 * the flattened DTO shape admitted `{}`. Pre-#472 clients only ever saw `delivered`.
 */
export const messageResponseSchema = z.union([
  z.object({ delivered: z.literal(true) }),
  z.object({ queued: z.literal(true), message: queuedMessageSchema }),
  z.object({ deferred: z.literal(true) }),
]);
export type MessageResponse = z.infer<typeof messageResponseSchema>;

/** `PATCH /runs/:id/queued-messages/:msgId` (#472) — the replaced entry. */
export const editQueuedMessageResponseSchema = z.object({ message: queuedMessageSchema });
export type EditQueuedMessageResponse = z.infer<typeof editQueuedMessageResponseSchema>;

/** `DELETE /runs/:id/queued-messages/:msgId` (#472) — `409 run already started` otherwise. */
export const removeQueuedMessageResponseSchema = z.object({ removed: z.literal(true) });
export type RemoveQueuedMessageResponse = z.infer<typeof removeQueuedMessageResponseSchema>;

/**
 * `POST /runs/:id/open-in-cli` — a terminal was spawned with `command` running in it. With no
 * terminal emulator the server answers 409 and the `ApiError` carries the full `cd … && <command>`
 * for the clipboard fallback.
 */
export const openInCliResponseSchema = z.object({
  opened: z.literal(true),
  command: z.string(),
});
export type OpenInCliResponse = z.infer<typeof openInCliResponseSchema>;

/** `POST /runs/:id/remove-worktree` — per-row delete in the worktrees panel (#483). */
export const removeWorktreeResponseSchema = z.object({ removed: z.literal(true) });
export type RemoveWorktreeResponse = z.infer<typeof removeWorktreeResponseSchema>;

/** `POST /runs/:id/git/commit` — `git add -A && git commit` in the run's worktree. */
export const gitCommitResponseSchema = z.object({
  committed: z.literal(true),
  sha: z.string(),
});
export type GitCommitResponse = z.infer<typeof gitCommitResponseSchema>;

/** `POST /runs/:id/git/push` — push the worktree's branch, setting upstream if it has none. */
export const gitPushResponseSchema = z.object({
  pushed: z.literal(true),
  branch: z.string(),
  remote: z.string(),
  upstreamSet: z.boolean(),
});
export type GitPushResponse = z.infer<typeof gitPushResponseSchema>;

/** A commit a run made on its worktree branch. */
export const runCommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  author: z.string(),
  /** Relative time ("3 hours ago") — git's `%cr`. */
  when: z.string(),
});
export type RunCommit = z.infer<typeof runCommitSchema>;

/** `GET /runs/:id/commits` — `<base>..HEAD` on the worktree branch, newest first. */
export const runCommitsResponseSchema = z.object({ commits: z.array(runCommitSchema) });
export type RunCommitsResponse = z.infer<typeof runCommitsResponseSchema>;

// ---- parallel variants (spec 010) ----------------------------------------------------------
//
// `/groups/:groupId/*` is the RUN family seen sideways: a group is the runs sharing a `groupId`,
// and the pick answers a whole run record. So these live here rather than with the workflows,
// which keeps `./workflows.ts` free of any edge back into this file (see its header).

/**
 * One variant column of the compare view.
 *
 * CAREFUL: `diffStat` here is the raw `git diff --stat` TEXT the server runs in the variant's
 * worktree — a different thing from the numeric `RunRecord.diffStat`. `''` when the worktree
 * is gone.
 */
export const groupVariantSchema = z.object({
  id: z.string(),
  /** 'A' | 'B' | 'C' in practice; `'?'` for a record that lost its letter. */
  variant: z.string(),
  title: z.string(),
  status: runStatusSchema,
  archived: z.boolean(),
  tokensUsed: z.number(),
  costUsd: z.number().optional(),
  diffStat: z.string(),
  /** First lines of the handoff journal's "## Progress log" section, as markdown. */
  handoffExcerpt: z.string(),
});
export type GroupVariant = z.infer<typeof groupVariantSchema>;

/** `GET /groups/:groupId` — every run sharing a groupId, side by side. */
export const groupResponseSchema = z.object({
  groupId: z.string(),
  runs: z.array(groupVariantSchema),
});
export type GroupResponse = z.infer<typeof groupResponseSchema>;

/**
 * `POST /groups/:groupId/pick` — the winner (parked at `review` when it has a diff); the losers
 * were cancelled if alive, archived, and their worktrees + branches removed.
 *
 * `winner` is OPTIONAL because that is what the wire says: `store.getRun(id)` can miss, and
 * `JSON.stringify` drops a key whose value is `undefined`. The handler spreads the key in
 * conditionally (`server.ts`, the `/groups/:groupId/pick` route) so its own type says the same
 * thing — the two-way check in `contract-parity.workflows.test.ts` is what pins that.
 */
export const pickVariantResponseSchema = z.object({
  winner: runRecordSchema.optional(),
});
export type PickVariantResponse = z.infer<typeof pickVariantResponseSchema>;

// ---- request bodies ----------------------------------------------------------------------
//
// Request types are `z.input`, not `z.infer`: a caller writes what the schema ACCEPTS, and the
// defaults/transforms below (`text`, `images`, `systemPrompt`) mean the parsed output is not the
// same shape. `z.infer` here would demand keys the server fills in for you.

/** An inline image, base64 — ≤4 per request, ~5 MB each once decoded. */
export const imageInputSchema = z.object({
  mediaType: z.string().regex(/^image\//),
  data: z.string().min(1).max(7_000_000),
});
export type ImageInput = z.input<typeof imageInputSchema>;

/**
 * The KEYS of `POST /runs`' body, before the XOR refinement that `createRunInputSchema` adds.
 *
 * Split out for one reason: `./automations.ts` builds an automation's task on top of this shape
 * (a task IS a run-creation body minus the three keys an automation supplies itself), and zod
 * refuses `.omit()` on a schema that carries refinements. Validate with `createRunInputSchema`
 * below — this half accepts a body naming both `workflow` and `steps`, which the server does not.
 */
export const createRunInputBaseSchema = z
  .object({
    workflow: z.string().min(1).optional(),
    /** An inline chain (spec 008 — an approved plan runs as an ad-hoc workflow, never written to
     *  a file). The catalog's own step shape, not a copy of it. */
    steps: z.array(workflowStepDefSchema).min(1).max(8).optional(),
    task: z.string().min(1).max(100_000, 'must be at most 100000 characters'),
    model: z.string().optional(),
    runner: runnerSchema.optional(),
    /** 1–3. Above 1 the response is `{ runs }` rather than a single record. */
    variants: z.number().int().min(1).max(3).optional(),
    /** false → run in the repo working tree instead of an isolated worktree (read-only skills).
     *  Omit for the default. Ignored server-side when variants > 1. */
    worktree: z.boolean().optional(),
    /** true → autonomous run: never parks at "waiting"; auto-continues until done. */
    autonomous: z.boolean().optional(),
    /** false → keep the handoff journal but do not expose or request a follow-up todos file.
     *  Omit for the default (enabled); a server with the capability off pins it to false. */
    generateFollowups: z.boolean().optional(),
    /** Per-run system-prompt override (R2 2.3) — programmatic callers only. Wins over the
     *  config.json default; whitespace-only degrades to absent. */
    systemPrompt: z
      .string()
      .trim()
      .max(20_000, 'must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
    /** Screenshots pasted into the new-task form; delivered with the first agent step. */
    images: z.array(imageInputSchema).max(4).optional(),
    /** The inbox entry this task came from (#374). Best-effort bookkeeping: an unknown or
     *  already-started id never fails the run. For ×2/×3 the FIRST variant is recorded. */
    todoId: z.string().min(1).max(200, 'must be at most 200 characters').optional(),
  });

/**
 * `POST /runs`. Exactly one of `workflow` / `steps` — the server rejects both or neither.
 *
 * Every bound here is the server's own (#429): an unbounded body must never reach a spawned
 * process, so a client that validates before sending gets the same answer the route would give.
 */
export const createRunInputSchema = createRunInputBaseSchema.refine(
  (b) => Boolean(b.workflow) !== Boolean(b.steps),
  { message: 'provide either "workflow" or "steps", not both' },
);
export type CreateRunInput = z.input<typeof createRunInputSchema>;

/**
 * `POST /runs/:id/messages` — text and/or pasted screenshots for a live session. Both keys have
 * server-side defaults, so an omitted `text` is `''` and an omitted `images` is `[]`; the refine
 * is what rejects a message that is empty in both.
 */
export const messageInputSchema = z
  .object({
    text: z.string().max(100_000).default(''),
    images: z.array(imageInputSchema).max(4).default([]),
  })
  .refine((m) => m.text.trim().length > 0 || m.images.length > 0, {
    message: 'message needs text or at least one image',
  });
export type MessageInput = z.input<typeof messageInputSchema>;

/**
 * `PATCH /runs/:id` (#389). `title` is trimmed server-side, 1–300 chars, and the edit sets both
 * `title` and `titleSummary` so it wins over any auto-summary. `task` (#472) is the initial
 * prompt, editable only while the run is still queued — any other status answers
 * `409 run already started`, and the folded total across the task and its stack bounds it again.
 */
export const patchRunInputSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  task: z.string().trim().min(1).max(100_000).optional(),
});
export type PatchRunInput = z.input<typeof patchRunInputSchema>;
