import { z } from 'zod';
import { runnerSchema } from './health.ts';
import { referenceStatusSchema } from './github.ts';
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

const usageCounterSchema = z.number().finite().nonnegative();

/** One step of a run's chain. */
export const stepStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'check']),
  status: stepStatusSchema,
  iterations: z.number(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
  usageInvocationsStarted: usageCounterSchema.optional(),
  usageInvocationsObserved: usageCounterSchema.optional(),
  usageTurnsStarted: usageCounterSchema.optional(),
  usageTurnsRecorded: usageCounterSchema.optional(),
  usageInvocationEpoch: usageCounterSchema.optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
  /** Latest agent session id — `claude --resume <id>` and friends. */
  sessionId: z.string().optional(),
  /** Backend that owns `sessionId`; absent on records written before backend affinity. */
  backend: runnerSchema.optional(),
  /** Agent account (spec 2026-07-29-agent-profiles) that owns `sessionId` — `default`, or a
   *  stored profile id. The two are a PAIR: a session id only resolves inside the config dir
   *  that created it, so resume and Continue read this rather than the project's current
   *  selection. Absent on records written before accounts existed. */
  profileId: z.string().optional(),
  costUsd: z.number().optional(),
});
export type StepState = z.infer<typeof stepStateSchema>;

/** Aggregate diff numbers of a run's worktree vs its base (#389). */
export const diffStatSchema = z.object({
  adds: z.number(),
  dels: z.number(),
  files: z.number(),
  /** Additive since #751, and present ONLY when true: the numbers were measured against a
   *  branch the agent checked out into the task's worktree, as the run found it, because the
   *  worktree's HEAD had been repointed off the task's own branch (every review/QA run does
   *  this) and the merge-base anchor would otherwise have reported that branch's entire diff
   *  as this task's. Absent on every normal run and on every record written before #751 — a
   *  consumer that ignores it sees exactly the old shape. */
  repointed: z.boolean().optional(),
});
export type DiffStat = z.infer<typeof diffStatSchema>;

/** One prompt message stacked onto a run while it waits for a free agent slot (#472). */
export const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** `/api/v1/runs/:id/images/…` URLs — attachments are persisted, never inlined. Images and
   *  files share this one list; read `isImageAttachmentName` on the file name to tell them apart. */
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
  /** URLs of the attachments on the initial task prompt (#image-display) — images and, since
   *  #950, files. One list, one numbering space; branch on `isImageAttachmentName`. */
  taskImages: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Normalized provider/model identity used for attribution and reproducible replay. */
  modelIdentity: z.string().optional(),
  runner: runnerSchema.optional(),
  /** The composer's per-task agent account (spec 2026-07-29-agent-profiles), applying to steps
   *  on `runner`. Absent = the run follows the project's own selection. */
  agentProfile: z.string().optional(),
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
  /** Exact ISO-8601 instant this run resumes itself after a provider usage limit stopped it
   *  (spec 2026-08-03-auto-resume-after-usage-limit). Present only on a `failed` run with a
   *  pending automatic resume — its absence is what "no resume is scheduled" looks like. */
  autoResumeAt: z.string().optional(),
  /** Consecutive automatic resumes since the last human turn, against the safety cap. */
  autoResumeAttempts: z.number().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
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
  /** Explicit execution policy. `false` means the run intentionally uses the repo root;
   *  absent on older runs and for the default isolated-worktree mode. */
  worktree: z.literal(false).optional(),
  /** Absent for in-place runs and after an isolated worktree is removed. */
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  /** Stable baseline for session git views: a worktree's fork ref, or an in-place run's starting commit. */
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
  /** Read receipt (#unread-done-items): ISO time the cockpit last opened this run's
   *  thread. A finished (`done`/`failed`) run reads as *unread* until seen since it
   *  finished — see `isUnread()` in the cockpit's `lib/read-state.ts`. Absent on old
   *  runs, on any run not yet opened, and on one deliberately put back to unread via
   *  `POST /runs/:id/unread` (#775) — all three count as unread. */
  seenAt: z.string().optional(),
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

// ---- the cross-project index --------------------------------------------------------------

/**
 * One run in the WORKSPACE-level index (`GET /api/v1/workspace/runs-index`) — the ⌘K palette's
 * "find a task in any project" list, and the global Tasks page's rows.
 *
 * Deliberately a separate, slim shape rather than `ApiRun`. The index answers for every
 * registered project at once, and `runRecordSchema` carries `steps[]` and `workflowDef` — a fat
 * record whose cost is fine per project and absurd multiplied by the registry. These are exactly
 * the fields a palette row renders: `runTitle`'s three (`title`, `titleSummary`, `titleOrigin`),
 * `deriveAttention`'s `AttentionInput`, `isUnread`'s `ReadStateInput`, and the timestamps
 * `shortAge` reads. Adding a field here is cheap; adding the whole record is what this exists to
 * avoid — but note that widening either of those two `Pick`s means widening this too, or the
 * palette's cross-project rows silently answer differently from every other surface.
 *
 * `projectId` is the join key, NOT the project name: the registry is already on the client and is
 * authoritative for display names, and duplicating one here would let a renamed project show two
 * different labels in one palette.
 */
export const runIndexEntrySchema = z.object({
  /** The registered project this run belongs to. Joins against `GET /projects`. */
  projectId: z.string(),
  id: z.string(),
  title: z.string(),
  titleSummary: z.string().optional(),
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  status: runStatusSchema,
  activity: runActivitySchema.optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  /** With `status`/`finishedAt`/`archived`, the four inputs `isUnread` reads — what lets the
   *  palette lead with "finished while you weren't looking" across every project, not just the
   *  one you happen to be standing in. */
  seenAt: z.string().optional(),
  /** Always present, like `RunRecord.archived`: absent would read as "not archived", and the
   *  unread rule treats archiving as a stronger "done with this" than reading. */
  archived: z.boolean(),
  /** A run parked by a provider usage limit is `failed` on the record with a resume booked
   *  (spec 2026-08-03-auto-resume-after-usage-limit). Both `deriveAttention` and `isUnread` read
   *  it, so without it here a cross-project row would show a red "failed" dot and land in
   *  Recently finished for work that is simply waiting for its appointment. */
  autoResumeAt: z.string().optional(),
  /** The workflow the run executes — the global Tasks page shows it in a column and groups by
   *  it. Always present on the record (`RunRecord.workflow`), so required here; the display
   *  refinement `workflowLabel` applies needs `steps[]`, which this row deliberately omits, so
   *  a `(planned)` chain reads as itself here rather than as its first agent's name. */
  workflow: z.string(),
  /** The task's branch, when it has one — a column on the global page, and the one field that
   *  makes a cross-project row identifiable at a glance without opening it. */
  branch: z.string().optional(),
  /** When the agent actually started, as opposed to when the task was created. The global page's
   *  age column prefers it and falls back to `createdAt`, exactly as the per-project table does. */
  startedAt: z.string().optional(),
  /**
   * The six fields `taskReference()` (`web/src/lib/tasks-table.ts`) reads to decide a task's PR
   * or issue chip. Carried verbatim rather than pre-resolved into a `{kind, number, url}` on the
   * server, because the rule that picks between them is subtle (#407, #526: a run that REVIEWED
   * a PR must not claim it as its own, an issue-subject run must not adopt an incidental
   * transcript PR) and it already exists, tested, on the client. Resolving it a second time
   * server-side would be a second rule, and the two would drift.
   *
   * Six scalars is still the slim row this schema exists to keep: `steps[]` and `workflowDef`,
   * the expensive half, stay off it.
   */
  pullRequestUrl: z.string().optional(),
  referencedPullRequestUrl: z.string().optional(),
  prNumber: z.number().optional(),
  issueNumber: z.number().optional(),
  referencedIssueUrl: z.string().optional(),
  markerRefs: z.object({ pr: z.number().optional(), issue: z.number().optional() }).optional(),
  /** What the run has cost so far. Absent means nothing was recorded, which is NOT `$0` — the
   *  cockpit prints an em dash rather than claiming a measurement that never happened. */
  costUsd: z.number().optional(),
  /** The persisted high-water marks a FINISHED run leaves behind. `usage` below stops existing
   *  the moment the process tree does, so without these a finished row could say nothing at all
   *  about what it took to run. */
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  /**
   * The live CPU/RSS sample of this run's process tree, attached on the way out exactly as
   * `GET /runs` attaches it (`withUsage`) — never persisted.
   *
   * It can ride a WORKSPACE-level answer because the sampler is process-wide: one cezar process
   * runs every project's agents, so `currentUsage(runId)` knows about a run whatever project it
   * belongs to. That is what lets a cross-project table show live usage without opening one
   * event stream per project (it could not — the run stream is project-scoped).
   */
  usage: processUsageSchema.optional(),
});
export type RunIndexEntry = z.infer<typeof runIndexEntrySchema>;

/**
 * `GET /workspace/runs-index`.
 *
 * `truncated` is not decoration: the index caps each project's contribution, and a capped list
 * that says nothing reads as "your task is not here" when the honest answer is "not in the
 * newest N". Naming the projects that hit the cap is what lets a consumer say so.
 */
/**
 * Everything the SERVER already knew about the references its rows carry, per project — the
 * statuses that would otherwise cost a second round trip a beat after the table paints.
 *
 * Read from cache only: this never asks the forge, so a cold entry is simply absent and
 * `GET /github/ref-status` stays the route that actually goes and looks. That makes it free, and
 * being free is what lets it be a superset — the server looks up every number a run mentions
 * rather than re-deriving which one the cockpit will display (#407, #526 live client-side, and
 * duplicating that rule is how the two would drift).
 */
export const referenceStatusesByProjectSchema = z.record(
  z.string(),
  z.object({
    prs: z.record(z.number(), referenceStatusSchema),
    issues: z.record(z.number(), referenceStatusSchema),
  }),
);

export const runsIndexResponseSchema = z.object({
  /** Newest first, across every registered project. Archived runs are included — `GET /runs`
   *  carries them for the project you are standing in, and a finder that dropped them elsewhere
   *  would make a task vanish the moment you left its project. */
  runs: z.array(runIndexEntrySchema),
  /** Additive: absent statuses mean "nothing warm", never "nothing to show". */
  referenceStatuses: referenceStatusesByProjectSchema,
  /** The per-project cap that produced this list. */
  perProjectLimit: z.number(),
  /** Ids of the projects that had more runs than the cap allowed. */
  truncated: z.array(z.string()),
});
export type RunsIndexResponse = z.infer<typeof runsIndexResponseSchema>;

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

/**
 * `DELETE /runs/:id/auto-resume` (spec 2026-08-03-auto-resume-after-usage-limit) — the per-task
 * off switch for a pending usage-limit resume, next to the workspace-wide setting.
 *
 * `z.literal(true)`, not a boolean, and that IS the shape: the route is idempotent, so a run with
 * nothing pending answers 200 as well — "this task will not resume itself" is equally true either
 * way. Only an unknown run refuses, with 404.
 */
export const cancelAutoResumeResponseSchema = z.object({ cancelled: z.literal(true) });
export type CancelAutoResumeResponse = z.infer<typeof cancelAutoResumeResponseSchema>;

/** `POST /runs/archive-finished` — how many runs the sweep archived. */
export const archiveFinishedResponseSchema = z.object({ archived: z.number() });
export type ArchiveFinishedResponse = z.infer<typeof archiveFinishedResponseSchema>;

/** `POST /runs/read-all` — how many unread finished runs the sweep marked read. */
export const markAllReadResponseSchema = z.object({ read: z.number() });
export type MarkAllReadResponse = z.infer<typeof markAllReadResponseSchema>;

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
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
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

/**
 * Non-image attachment types the composer may send (#950). Deliberately an allowlist and
 * deliberately short: cezar serves these files back from the cockpit's own origin, so every entry
 * here is one more thing that must be safe to hand a browser. `image/*` stays a regex — narrowing
 * what the route has always accepted would be the breaking half of this change.
 *
 * `text/x-markdown` is the spelling some browsers still report for a `.md`.
 */
export const FILE_ATTACHMENT_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/pdf',
] as const;

/** Does this media type travel as an inline image block the model can look at? */
export function isImageMediaType(mediaType: string): boolean {
  return /^image\//.test(mediaType);
}

/** Is this something the composer may attach at all — an image, or one of the file types above? */
export function isAttachmentMediaType(mediaType: string): boolean {
  return (
    isImageMediaType(mediaType) ||
    (FILE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(mediaType)
  );
}

/**
 * The on-disk extension for an attachment, derived from its media type ALONE — the user's own
 * filename never reaches the wire, and therefore never reaches a path. `img` is the pre-existing
 * catch-all for an image type cezar does not name (an SVG, a BMP), kept so those files land where
 * they always did.
 */
export function attachmentExtension(mediaType: string): string {
  return /png/.test(mediaType) ? 'png'
    : /jpe?g/.test(mediaType) ? 'jpg'
    : /webp/.test(mediaType) ? 'webp'
    : /gif/.test(mediaType) ? 'gif'
    : mediaType === 'application/pdf' ? 'pdf'
    : mediaType === 'text/plain' ? 'txt'
    : mediaType === 'text/markdown' || mediaType === 'text/x-markdown' ? 'md'
    : 'img';
}

/** Extensions `attachmentExtension` produces for an inline image. */
const IMAGE_ATTACHMENT_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'img']);

/**
 * Does a persisted attachment name (`pasted-3.pdf`, `screenshot-1.png`) refer to an image?
 *
 * The one predicate every reader branches on — the engine deciding whether to re-encode a file as
 * an image block, and the cockpit deciding between a thumbnail and a named chip. Branch on the
 * NAME, never on the list an entry came from: images and files share one list and one numbering
 * space on disk, and that is what keeps the orphan sweep, the restart re-read and the per-stack
 * cap on a single code path.
 */
export function isImageAttachmentName(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext !== undefined && IMAGE_ATTACHMENT_EXTENSIONS.has(ext);
}

/**
 * One inline attachment, base64 — ≤4 per request, ~5 MB each once decoded.
 *
 * An image rides along as a block the model can view; a file (#950) is written to the run's
 * attachment folder and reaches the agent as a PATH only, which is the form its file tools want,
 * the only form that survives the codex/opencode backends (they drop image blocks before the
 * model sees them), and the one that keeps a multi-megabyte PDF out of the prompt bounds.
 */
export const attachmentInputSchema = z.object({
  mediaType: z.string().refine(isAttachmentMediaType, {
    message: 'unsupported attachment type — images, plain text, markdown and PDF only',
  }),
  data: z.string().min(1).max(7_000_000),
});
export type AttachmentInput = z.input<typeof attachmentInputSchema>;

/** @deprecated Attachments are no longer images only — use `attachmentInputSchema`. Kept because
 *  the `images` key it validates is the wire contract and did not change name. */
export const imageInputSchema = attachmentInputSchema;
export type ImageInput = AttachmentInput;

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
    /** Agent account for this task (spec 2026-07-29-agent-profiles). Omit to follow the
     *  project's own selection; an id that no longer exists is a 400, not a silent default. */
    agentProfile: z.string().max(64).optional(),
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
    /** Attachments pasted into the new-task form — screenshots, and since #950 PDF/TXT/MD files
     *  too; delivered with the first agent step. The key keeps its name: the wire contract widened
     *  in place rather than growing a second list. */
    images: z.array(attachmentInputSchema).max(4).optional(),
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
 * `POST /runs/:id/messages` — text and/or pasted attachments for a live session. Both keys have
 * server-side defaults, so an omitted `text` is `''` and an omitted `images` is `[]`; the refine
 * is what rejects a message that is empty in both.
 */
export const messageInputSchema = z
  .object({
    text: z.string().max(100_000).default(''),
    images: z.array(attachmentInputSchema).max(4).default([]),
  })
  .refine((m) => m.text.trim().length > 0 || m.images.length > 0, {
    message: 'message needs text or at least one attachment',
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
