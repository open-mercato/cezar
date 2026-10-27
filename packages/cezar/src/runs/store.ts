import { deferredBindingSchema, queueWaitReasonSchema } from '@open-mercato/cezar-contract';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { hostname, uptime } from 'node:os';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { StreamRedaction } from './stream-redaction.ts';
import { renameSyncWithRetry } from '../fs-rename.ts';
import { collectSecretValues, redactDeep, redactSecrets } from '../core/secret-redaction.ts';
// Sibling module, files only — a draft belongs to a run and is deleted with it (#939).
import { deleteRunDrafts } from './drafts.ts';
import { deleteRunLayouts, pruneOrphanLayouts } from './layouts.ts';
import { failureKind, taskFailedLabel } from './failure-kind.ts';
import { track } from '../telemetry.ts';
import { reportAgentError } from './agent-error-telemetry.ts';
// Pure, dependency-free reference helpers — the same sanity bound the marker parser applies.
import { MAX_REF } from './task-refs.ts';
// Type-only module (zod + nothing else), so this cannot cycle back into the store.
import { workflowDefSchema } from '../workflows/types.ts';
// A contract VALUE, like `workspaceUiStateSchema` in `workspace/migrations.ts`: the persisted
// `dispatch` object and its wire half are literally the same schema, so they cannot drift.
import { dispatchSchema, trackerAssociationSchema, trackerAutomationEventSchema, worktreeLifecycleProjectionSchema } from '@open-mercato/cezar-contract';

import { RUNNER_IDS } from '../core/agent-runner.ts';

import type { RunnerId } from '../core/agent-runner.ts';

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled';
/**
 * A sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490):
 * the agent ended its turn still working on its own downstream work (a sub-agent
 * or a monitored command) and declared it with the `CEZ:MONITORING` marker — so
 * the cockpit shows a non-attention "monitoring" label instead of "needs you".
 * Only ever set while `status === 'running'`; cleared on resume/terminal.
 */
export type RunActivity = 'monitoring';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

const usageCounterSchema = z.number().finite().nonnegative();

/**
 * A runner id as it may appear in a PERSISTED record, normalized to the
 * ids the rest of cezar speaks (#547).
 *
 * `claude-cli` is the legacy spelling of `claude` — still a member of
 * `AgentBackend` and still accepted by `createRunner`, and named by
 * `BACKWARD_COMPATIBILITY.md` §3 as an id `runs.json` keeps parseable. The enum
 * here did not accept it, so that promise was false: the loader `safeParse`s the
 * WHOLE array, so one record carrying it would have dropped every run in the
 * file — the exact failure mode §3 exists to warn about.
 *
 * Parse-and-fold rather than widen: the legacy id is accepted on the way in and
 * collapsed to `claude`, so no consumer, wire type or contract schema ever sees
 * an extra runner. The narrowing is one-way and permanent (the index is
 * re-serialized from the parsed records), which is what "old run records
 * normalise identically to `claude`" in `core/model-identity.ts` has always
 * claimed. Use ONLY for read-back of stored state — request bodies, settings and
 * workflow step defs stay the selectable ids (`RunnerId`), because nothing
 * should be able to ASK for the legacy spelling.
 */
const storedRunnerSchema = z
  .enum([...RUNNER_IDS, 'claude-cli'])
  .transform((id) => (id === 'claude-cli' ? ('claude' as const) : id));

const stepStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['agent', 'check']),
  status: z.enum(['pending', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled', 'skipped']),
  iterations: z.number(),
  // #1300: unreadable accounting follows the same bounded fallback as legacy records.
  retriesUsed: z.number().int().nonnegative().optional().catch(undefined),
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
  /** Latest backend-owned session id, used for same-backend Continue. */
  sessionId: z.string().optional(),
  /** Backend that owns `sessionId`. Optional so pre-affinity runs.json files still parse;
   *  `storedRunnerSchema` so a legacy `claude-cli` folds to `claude` instead of failing (#547). */
  backend: storedRunnerSchema.optional(),
  /** Agent profile (account) this step actually spawned under — `default`, or a stored profile
   *  id (spec 2026-07-29-agent-profiles). Recorded rather than re-derived because a session id
   *  only means something inside the config dir that created it: `sessionId` and `profileId` are
   *  a PAIR. Without it, changing the project's account would silently make Continue resume
   *  against the wrong account's session store. Absent = the discovered default. */
  profileId: z.string().optional(),
  /** Canonical provider/model identity resolved for this step. Optional so older runs.json files
   *  remain readable and auto-model steps can retain an absent identity. */
  modelIdentity: z.string().optional(),
  /** Dollar cost reported by the claude CLI for this step's turns. */
  costUsd: z.number().optional(),
});

/** One prompt message stacked onto a run while it waits for a free agent slot
 *  (#472). Folded into `{{task}}` at dequeue by `hydrateQueuedInput`; never
 *  delivered as its own turn — a follow-up turn would reach only the first step
 *  of a chain and would race the opening turn. */
const queuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** `/api/v1/runs/:id/images/…` URLs — the base64 never enters `runs.json`. */
  images: z.array(z.string()).optional(),
  createdAt: z.string(),
});

/** One authoritative PR association for a task. Older records project their scalar fields
 * into this list on first append, so no migration is needed. */
const prRefSchema = z.object({
  number: z.number().int().positive().max(MAX_REF),
  url: z.string().url().optional(),
  origin: z.enum(['created', 'marker', 'legacy', 'derived']),
  at: z.string().datetime(),
});
export type RunPrRef = z.infer<typeof prRefSchema>;

/** Exported for `./run-index.ts`, the read-only reader of the same file. Nothing else should
 *  parse `runs.json` — see `reconcileLoadedRun` for why a second parser is a correctness risk. */
export const runRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Display title (#389): the auto-derived summary of the first agent turn,
   *  or the user's inline edit (`PATCH /api/runs/:id` sets it together with
   *  `title` so edits always win). The UI shows `titleSummary ?? title`. */
  titleSummary: z.string().optional(),
  /** `git diff --shortstat` of the worktree vs its base, refreshed on every
   *  turn-end (#389) — what the quick list / table shows without a git call.
   *  `repointed` (#751) is optional and only ever written as `true`: it marks the
   *  runs whose numbers were narrowed to uncommitted work because the agent had
   *  checked another branch out into the worktree. Optional is load-bearing here —
   *  `runs.json` is `safeParse`d as one array, so a required addition would
   *  silently drop every pre-existing run. */
  diffStat: z
    .object({
      adds: z.number(),
      dels: z.number(),
      files: z.number(),
      repointed: z.boolean().optional(),
    })
    .optional(),
  workflow: z.string(),
  task: z.string(),
  /** Prompt messages stacked onto this run while it was queued (#472). Optional:
   *  `undefined` on every pre-#472 record reads as an empty stack. Like `task`,
   *  `text` is the user's own prompt and is replayed into `{{task}}`, so it is
   *  deliberately NOT in `redactPatch`'s field list — scrubbing it would corrupt
   *  the run the same way scrubbing `task` would. */
  queuedMessages: z.array(queuedMessageSchema).optional(),
  /** URLs of images attached to the initial task prompt, for the thread's first bubble
   *  (#image-display) — persisted like agent screenshots, served from `/images/`. */
  taskImages: z.array(z.string()).optional(),
  model: z.string().optional(),
  /** Canonical provider/model identity (#405) — the normalised `provider/model`
   *  (e.g. `anthropic/claude-opus-4-8`) the run actually used, resolved from the
   *  free-text `model` against the chosen runner. Additive and optional: pre-#405
   *  records carry only `model`, and it stays the human/hand-edit surface; this
   *  is the parseable identity cost attribution and reproducible replay key off.
   *
   *  Read in production by the session header's agent badge (#546), which shows it
   *  whenever it says something `model` does not — so this is no longer a
   *  write-only field whose next reader has to guess whether it is load-bearing. */
  modelIdentity: z.string().optional(),
  /** Agent backend this run used — drives "open in CLI" resume command. `storedRunnerSchema`
   *  so a legacy `claude-cli` record folds to `claude` instead of failing the whole index (#547). */
  runner: storedRunnerSchema.optional(),
  /** Per-task agent-account override from the composer (spec 2026-07-29-agent-profiles), applying
   *  to steps that run on `runner`. Steps on a DIFFERENT backend still resolve from the project's
   *  own selection — an override for Claude says nothing about which Codex account a mixed
   *  workflow's codex step should use. Absent = follow the project. */
  agentProfile: z.string().optional(),
  /** Echo of the extra system prompt this run actually used (R2): the
   *  `POST /api/runs` override, or the `config.json` default it fell back to.
   *  Deliberately NOT the full composed prompt — skill bodies and the handoff
   *  contract are derivable from the persisted workflow and would bloat the
   *  index. Resolved at execute time (a queued run picks up config edits). */
  systemPrompt: z.string().optional(),
  /** Per-task follow-up inbox contract (spec 007, #444). Missing on old runs
   *  means enabled — the historical behavior. */
  generateFollowups: z.boolean().optional(),
  /** Autonomous mode (#489): the run was started with the "autonomous" checkbox,
   *  so it never parks at `waiting` (auto-nudge) and — once persisted here —
   *  never parks at the terminal `review` gate either (`settleSuccess` + the
   *  group-pick winner-park read it). Additive-safe: absent = falsy = not
   *  autonomous. Set at creation from `WorkflowInput.autonomous`. */
  autonomous: z.boolean().optional(),
  /** Optional provenance for tasks launched by a project GitHub automation. */
  automation: z
    .object({
      automationId: z.string(),
      automationRevision: z.number().int().positive(),
      receiptId: z.string(),
      event: z.string(),
      githubUrl: z.string().url(),
    })
    .optional(),
  /** Account/workflow confirmed for a composer-scheduled start (#1340); checked at launch. */
  deferredBinding: deferredBindingSchema.optional(),
  queueWaitReason: queueWaitReasonSchema.optional(),
  /** Provenance for a task a scheduled automation launched (spec 2026-09-14). Its own key so a
   *  pre-schedule cezar strips it instead of failing the whole index on a missing `githubUrl`. */
  automationTrigger: z
    .object({
      automationId: z.string(),
      automationRevision: z.number().int().positive(),
      receiptId: z.string(),
      trigger: z.enum(['schedule', 'catch-up', 'manual']),
      occurrenceAt: z.string(),
    })
    .optional(),
  /** Provenance for a task a tracker (Jira/Linear) automation launched. Its own key, same reason
   *  as `automationTrigger`: a pre-tracker cezar strips it instead of failing the whole index.
   *  The optional association binds credentials to the exact source, scope and connection
   *  that fired the run. Legacy records without that snapshot receive no tracker credentials.
   *  No secret is stored on this record. */
  automationTracker: z
    .object({
      automationId: z.string(),
      automationRevision: z.number().int().positive(),
      receiptId: z.string(),
      provider: z.enum(['jira', 'linear']),
      association: trackerAssociationSchema.optional(),
      eventId: z.string().optional(),
      event: trackerAutomationEventSchema.optional(),
      timestamp: z.string().optional(),
      change: z.object({ fromId: z.string().optional(), toId: z.string().optional(), labelId: z.string().optional(), labelName: z.string().optional() }).optional(),
      key: z.string(),
      url: z.string().url(),
    })
    .optional(),
  /** This run's place in a dispatch tree (spec 2026-09-10-dispatch): root, parent, kind,
   *  budget, its own report and the reports waiting for its next session.
   *
   *  The CONTRACT's own `dispatchSchema` rather than a hand-copied twin — the one shape in this file
   *  that is imported instead of restated, the way `workspace/migrations.ts` imports
   *  `workspaceUiStateSchema`. Copying it would mean maintaining a nine-key nested object in two
   *  places whose only guard is a compile-time parity test; importing it makes them the same
   *  object. (`scripts/inline-contract.mjs` already folds the contract into `dist/` for exactly
   *  this reason, so no packaging follows from it.)
   *
   *  `.catch(undefined)` like `workflowDef` below: `runs.json` is plain, hand-editable JSON, and
   *  a `dispatch` that no longer fits must drop the FIELD, never the whole index. The run then reads
   *  as an ordinary flat task — degraded, but running. */
  dispatch: dispatchSchema.optional().catch(undefined),
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  /** Sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490):
   *  `monitoring` while the agent is still working on its own downstream work.
   *  Optional/absent on old runs; cleared when the run resumes or ends. */
  activity: z.enum(['monitoring']).optional(),
  /** Exact server-computed deadline for the next automatic monitoring check. */
  monitoringWakeAt: z.string().datetime().optional().catch(undefined),
  /** True only for the live epoch that exhausted all automatic monitoring checks. */
  monitoringWakeCapReached: z.boolean().optional(),
  /** This `waiting` is a MID-WORKFLOW park on a `CEZ:ASK` raised by a non-final
   *  agent step (#917), not the final interactive session. The difference is
   *  what has already run: a mid-workflow park still has later steps sitting at
   *  `pending`, so settling it as a success — which is right for the final step —
   *  would report work that never happened as done. Durable because the only
   *  reader that needs it, `recover()`, meets the run after a restart, when the
   *  in-memory park state is gone. Additive and optional (BACKWARD_COMPATIBILITY
   *  §3): absent on every record older than #917 and on every run that is not
   *  parked. Invariant: only a `waiting` run carries it — `updateRun` and
   *  `reconcileLoadedRun` retire it on any other status, so no caller has to. */
  askParked: z.boolean().optional(),
  /**
   * When the run's session ended — the inactivity timer, a crash, a cezar restart — while a
   * `CEZ:ASK` question was still unanswered. The run is `failed` on the record (no process, no
   * slot), but the question is still the user's to answer, so the cockpit keeps it under
   * "needs you" instead of filing it as an outcome; Continue (or the ask card) reopens the session
   * with the answer. Additive and optional (BACKWARD_COMPATIBILITY §3). Invariant: only a
   * `failed` run carries it — `updateRun` and `reconcileLoadedRun` retire it on any other status,
   * so a Continue, a Finish or a cancel clears it without the caller's help.
   */
  awaitingAnswerSince: z.string().datetime().optional().catch(undefined),
  /**
   * A run a `checkout: 'pr-head'` automation launched on a pull request's head (spec
   * 2026-10-06-agentic-e2e-checks Phase 3). `headSha` is what was fetched and tested — also the
   * run's `baseBranch` — and `ref` the namespaced `refs/cezar/pr/<n>` holding it. Its presence
   * is what refuses `POST /runs/:id/pr`: the branch would contain the whole foreign PR.
   */
  prHead: z
    .object({
      number: z.number().int().positive(),
      repo: z.string(),
      headRepo: z.string(),
      headRef: z.string(),
      headSha: z.string(),
      baseRef: z.string(),
      ref: z.string(),
    })
    .optional()
    .catch(undefined),
  /** The PR head came from a fork the automation admitted (`allowForkHeads`): untrusted code, so
   *  its check steps never receive any secrets. */
  untrustedHead: z.boolean().optional().catch(undefined),
  /**
   * Exact deadline at which a run stopped by a provider USAGE LIMIT resumes itself
   * (spec 2026-08-03-auto-resume-after-usage-limit) — the reset instant the provider named plus a
   * short grace. Present only while such a resume is pending: the run is `failed`, the timer is
   * armed, and the cockpit says so. Deliberately survives a restart (`RunStore.open` keeps it) —
   * it is what lets `recover()` re-arm a wait that may be hours long.
   */
  autoResumeAt: z.string().datetime().optional().catch(undefined),
  /** Consecutive automatic resumes since the last human turn — the safety cap's counter.
   *  Persisted so a restart cannot reset a loop back to zero. */
  autoResumeAttempts: z.number().int().min(0).optional().catch(undefined),
  /** Which automatic resume `autoResumeAt`/`autoResumeAttempts` belong to: a usage limit's reset
   *  window, or a retry after a transient provider failure — which holds no account. Absent = limit. */
  autoResumeReason: z.enum(['usage_limit', 'transient']).optional().catch(undefined),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  tokensUsed: z.number(),
  inputTokens: usageCounterSchema.optional(),
  outputTokens: usageCounterSchema.optional(),
  costUsd: z.number().optional(),
  /** First GitHub PR URL spotted in the transcript (the janitor trick). */
  pullRequestUrl: z.string().optional(),
  /** The PR this task is ABOUT (#407, spec 2026-07-16-pr-autodiscovery):
   *  auto-discovered from conversation references for tasks that work on an
   *  existing PR (review/continue/merge). Display-only tier — `pullRequestUrl`
   *  (the PR this task CREATED) always wins, and action gates ignore this. */
  referencedPullRequestUrl: z.string().optional(),
  /** The PR/issue number this task is ABOUT (spec 2026-07-17-task-auto-naming):
   *  regex-extracted from the task prompt, upgradable by the namer's
   *  cross-checked output. Display tier — never gates actions. */
  prNumber: z.number().optional(),
  /** Ordered, deduplicated PR associations. Optional for pre-list runs.json records. */
  prRefs: z.array(prRefSchema).max(8).optional().catch(undefined),
  issueNumber: z.number().optional(),
  /** Provenance for an `issueNumber` seeded by referenced-issue discovery.
   *  Persisted so ambiguity can revoke only the janitor's own value, including
   *  after a restart. Any prompt, namer, or marker write clears this flag. */
  referencedIssueNumberSeeded: z.boolean().optional(),
  /** Who owns the display title: `user` (PATCH rename — never auto-overwritten),
   *  `marker` (agent-declared via `CEZ:TITLE`, spec 2026-07-18-task-ref-markers —
   *  beats the namer, silences live refresh) or `auto` (namer-owned — a later
   *  namer result may replace it). Missing on old runs = legacy behavior (auto
   *  fills only an unset titleSummary). Precedence: user > marker > auto. */
  titleOrigin: z.enum(['user', 'auto', 'marker']).optional(),
  /** References the agent itself declared via `CEZ:PR=` / `CEZ:ISSUE=` markers
   *  (spec 2026-07-18-task-ref-markers). Presence of a kind makes it
   *  authoritative: the namer may no longer write that kind, and a declared PR
   *  owns the referenced tier's resolution. */
  markerRefs: z.object({ pr: z.number().optional(), issue: z.number().optional() }).optional(),
  /** Distinct PR URLs spotted so far — the referenced tier's working set,
   *  persisted so a resumed run keeps disambiguating against the full history
   *  instead of re-adopting the next URL as "the only one". Capped. */
  referencedPrCandidates: z.array(z.string()).optional(),
  /** The issue this task is ABOUT (spec 2026-07-21-report-ref-discovery):
   *  auto-discovered from `github.com/…/issues/N` links in the conversation,
   *  mirroring the referenced-PR tier. Display-only; never gates actions. */
  referencedIssueUrl: z.string().optional(),
  /** Distinct issue URLs spotted so far — the referenced-issue working set,
   *  persisted like `referencedPrCandidates`. Capped. */
  referencedIssueCandidates: z.array(z.string()).optional(),
  /** Explicit execution policy. `false` means the run intentionally uses the repo root;
   *  absent on older runs and for the default isolated-worktree mode. */
  worktree: z.literal(false).optional(),
  /** Task worktree (spec 006) — absent for in-place runs and after explicit cleanup. */
  worktreePath: z.string().optional(),
  worktreeLifecycle: worktreeLifecycleProjectionSchema.optional(),
  /** An in-place run that switched the repo checkout to `branch` before it started. */
  inPlaceBranch: z.literal(true).optional(),
  /** In-place but a read-only Ask task (spec 2026-10-20-trunk-based-projects): no lease, no
   *  writes, no landing. */
  readOnly: z.literal(true).optional(),
  /** The last auto-land of an in-place run (spec 2026-10-20-trunk-based-projects). */
  landing: z
    .object({
      status: z.enum(['landed', 'nothing', 'failed']),
      at: z.string(),
      branch: z.string().optional(),
      sha: z.string().optional(),
      pushed: z.boolean().optional(),
      files: z.array(z.string()).optional(),
      stage: z.string().optional(),
      error: z.string().optional(),
    })
    .optional(),
  /** The task's own branch, created off `baseBranch`: `cez/<id8>` unless branch naming
   *  instructions named it (spec 2026-10-11-branch-naming-instructions) — read it, never recompute it. */
  branch: z.string().optional(),
  /** Stable baseline for session git views: a worktree's fork ref, or an in-place run's starting commit. */
  baseBranch: z.string().optional(),
  /** Set when count-based retention (#483) reclaimed this run's worktree
   *  *directory* (the `cez/<id8>` branch is kept). Presence means "materialized
   *  dir gone, recoverable via `git worktree add`"; it excludes the run from the
   *  retention budget until the dir is re-materialized (resume clears it). */
  worktreeReclaimedAt: z.string().optional(),
  /** Parallel variants (spec 010): tasks sharing a groupId are one group. */
  groupId: z.string().optional(),
  /** Variant letter within the group — 'A' | 'B' | 'C' (kept as a string). */
  variant: z.string().optional(),
  /** Peak resident memory (bytes) / process count observed across the run's
   *  agent process trees (#348) — written when a session's telemetry ends.
   *  Optional: old runs.json files and `ps`-less platforms have neither. */
  peakRssBytes: z.number().optional(),
  peakProcCount: z.number().optional(),
  archived: z.boolean().default(false),
  archivedAt: z.string().optional(),
  /** Pinned to the top of this project's task list (#935): plain per-task state, the
   *  same class as `archived` and `seenAt`. Optional with NO default, unlike `archived`:
   *  absent is what every runs.json written before this carries and it already means
   *  "not pinned", so nothing needs filling in on parse and an unpin can simply delete
   *  the key rather than persist a `false` older cezars never wrote. */
  pinned: z.boolean().optional(),
  pinnedAt: z.string().optional(),
  /** Read receipt (#unread-done-items): the ISO time the cockpit last opened this
   *  run's thread. A finished run reads as "unread" until it has been seen since it
   *  finished — see `isUnread()` in the cockpit's `lib/read-state.ts`. Absent on old
   *  runs, on every run not yet opened, and on one `setUnread` put back to unread
   *  (#775) — the unread rule treats all three alike. */
  seenAt: z.string().optional(),
  /** Highest `seq` handed out for this run, ephemeral frames included, so a restart resumes the
   *  counter without parsing the transcript. Absent on older records, which fall back to that parse. */
  lastSeq: z.number().int().nonnegative().optional(),
  currentStepId: z.string().optional(),
  error: z.string().optional(),
  steps: z.array(stepStateSchema),
  /** Full workflow definition, persisted so a `queued` run can be re-enqueued
   *  after a restart (#367) — including ad-hoc "(planned)" chains that exist
   *  nowhere else.
   *
   *  Typed, not `z.record(z.string(), z.unknown())`: this key goes out over the
   *  wire on every run route, and `unknown` is wider than anything the server
   *  can serialize — which made the route's own type (hono's `JSONValue`, whose
   *  index signature admits `object | symbol | undefined`) impossible for the
   *  contract to describe. `.catch(undefined)` keeps an older or hand-edited
   *  entry from failing the whole index parse: a def that no longer fits simply
   *  drops, and `reviveWorkflow` falls back to the catalog by name.
   *
   *  That drop is PERMANENT, not per-boot — the index is re-serialized from the
   *  parsed records (`saveNow`), so the next save writes runs.json back without
   *  it. Harmless for a catalog workflow, which re-resolves by name; fatal for
   *  the ad-hoc "(planned)" chain this field exists to preserve, which has no
   *  catalog entry to fall back to. Nothing written since #367 fails the schema
   *  (`name`, `source` and `steps` have been on every persisted def), so tighten
   *  `workflowStepSchema` only with that in mind: a narrowing here silently eats
   *  queued runs rather than degrading them. */
  workflowDef: workflowDefSchema.optional().catch(undefined),
  /** Where a graph workflow's walk has been (spec 2026-09-30-workflow-node-editor, phase 3):
   *  per-loop counters and every edge taken, in order, as `<node>.<port>-><target>` (`to` empty
   *  when an unwired port ended the run). Written by `executeGraph` for the task view's live
   *  graph; absent on v1 runs and on every record that predates it. Capped (`GRAPH_TAKEN_CAP`). */
  graphState: z
    .object({
      loops: z.record(z.string(), z.number()),
      taken: z.array(z.string()),
      /** The node being run — where a restart resumes the walk. Absent once the walk ended. */
      cursor: z.string().optional(),
      /** `{{nodes.<id>.<field>}}` values so far, restored on resume. */
      outputs: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number()]))).optional(),
    })
    .optional()
    .catch(undefined),
});

export type StepState = z.infer<typeof stepStateSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;

/** One persisted event line; `type` mirrors AgentEvent plus engine lifecycle. */
export interface RunEvent {
  seq: number;
  ts: string;
  stepId?: string;
  type: string;
  [key: string]: unknown;
}

/** A layout file this young may belong to a run another process has not saved to the index yet. */
const ORPHAN_LAYOUT_GRACE_MS = 10 * 60_000;
const DEFAULT_RUNS_KEPT = 300;
const DEFAULT_ARCHIVED_KEPT = 500;
/** `CEZ_RUNS_KEEP` / `CEZ_ARCHIVED_RUNS_KEEP`: how many settled runs the index keeps (at least 1; live runs and active dispatch trees are never pruned). */
function keepLimit(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
/** Every save rewrites the whole index, and a live run touches its record at event rate. */
const SAVE_DEBOUNCE_MS = 1_000;
/** Statuses the run manager still acts on — a record in one of them must outlive pruning. */
const LIVE_STATUSES: ReadonlySet<string> = new Set<RunStatus>(['queued', 'running', 'waiting']);

// Any host: GitHub Enterprise lives on arbitrary domains (`isGithubHost` can't be asked from a regex).
const PR_URL_RE = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const ISSUE_URL_RE = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/issues\/\d+/;
// The transcript auto-link is convenience only (the cockpit's own `gh pr create` path sets the
// URL authoritatively). Adopt a PR URL ONLY when the agent actually CREATED one — a task that
// reviews or merely references an existing PR must not get mislabeled with its number (#fake-pr).
const CREATED_PR_RE =
  /\b(?:gh\s+pr\s+create|pull\s*request\s+created|created\s+(?:a\s+)?(?:draft\s+)?(?:pr|pull\s*request)|opened\s+(?:a\s+)?(?:draft\s+)?pull\s*request)\b/i;

/** Referenced-tier working-set cap (spec 2026-07-16-pr-autodiscovery): past
 *  this many distinct PRs the conversation is a survey, not a subject. */
const MAX_PR_CANDIDATES = 8;
/** Enough for any command line or path; a longer tool input is file content, not a reference. */
const MAX_TOOL_INPUT_HAYSTACK_CHARS = 8_192;

/** The repository a project IS, as `resolveRepoHandle` reports it. `null`/absent means "unknown",
 *  which is a real and common state (no `gh`, no remote, a non-git root) — never an error. */
export type RepoHandle = { owner: string; name: string };

/** `https://github.com/open-mercato/cezar/pull/402` → `open-mercato/cezar`, lowercased.
 *  Undefined for anything that is not a `<host>/<owner>/<repo>/<kind>/<n>` forge URL. */
function refUrlRepo(url: string): string | undefined {
  const parts = url.split('/');
  const owner = parts[parts.length - 4];
  const name = parts[parts.length - 3];
  return owner && name ? `${owner}/${name}`.toLowerCase() : undefined;
}

/**
 * May the referenced tier ADOPT this URL as the task's subject? (#945)
 *
 * The tier was text-scoped but never repo-scoped: `PR_URL_RE` matches any
 * `github.com/<owner>/<repo>/pull/N`, so a research task that cites one upstream PR handed the
 * resolver exactly one candidate and it became the task's identity — an `oko` task wearing
 * `supabase/cli#6056`. Nothing compared the URL's repository with the project's own.
 *
 * A foreign URL is adoptable only when the TASK PROMPT corroborates it: the prompt names that
 * `owner/repo`, which a pasted URL does inherently. That is the trust boundary this module already
 * uses elsewhere — the prompt and the agent's own turn text are trusted, scraped tool output is
 * not — and it is what keeps the legitimate cross-repo case working (#819:
 * `om-auto-fix-pr https://github.com/open-mercato/open-mercato/pull/1977` started from cezar).
 *
 * Unknown handle → today's behavior exactly (`AGENTS.md` zero config: degrade, never fail). An
 * unparseable URL is left alone for the same reason — the guard only ever removes an association
 * it can PROVE is foreign.
 *
 * Note what this does not touch: `referenced*Candidates` keep recording every URL as evidence.
 * The fix changes what is *promoted*, never what is *collected* (the #526 rule).
 */
// Compares `owner/repo` only: `RepoHandle` carries no host, so the same slug on another GitHub
// host (Enterprise vs github.com) reads as in-repo. Rare enough to accept; add a host to the
// handle if it ever bites.
function isRepoScopedRef(url: string, task: string, handle?: RepoHandle | null): boolean {
  if (!handle) return true;
  const repo = refUrlRepo(url);
  if (!repo) return true;
  if (repo === `${handle.owner}/${handle.name}`.toLowerCase()) return true;
  return task.toLowerCase().includes(repo);
}

/**
 * Every scannable string of one persisted event: the v1 top-level fields plus
 * the protocol-v2 `item.*` content (nested — the reason v2 streams were
 * invisible to the janitor, #407). Reasoning items are skipped: thinking text
 * speculates about PRs the task never touches.
 */
/**
 * Archiving IS resigning from a task, so an archived run can never carry a pending usage-limit
 * resume (spec 2026-08-03-auto-resume-after-usage-limit). The rule lives HERE rather than in the
 * archive route because the bulk "Archive finished" sweep never goes through that route, and a
 * user who archives fifty finished tasks has resigned from all fifty.
 *
 * The engine needs no telling: its timer re-reads the record before it fires and no sweep re-arms
 * an archived run, so a cleared field is the whole cancellation.
 */
function clearPendingAutoResume(run: RunRecord): void {
  run.autoResumeAt = undefined;
  run.autoResumeAttempts = undefined;
  run.autoResumeReason = undefined;
}

/** The OS refused the write (EPERM/EACCES/EROFS) — the file is there, cezar may not touch it. */
function isAccessDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

/**
 * Archiving is resigning from a task, so it also resigns from the question the task was left
 * waiting on — an archived run must not keep a "needs you" signal alive in the attention layer.
 */
function clearAwaitingAnswer(run: RunRecord): void {
  run.awaitingAnswerSince = undefined;
}

/**
 * Archiving is resigning from a task, so it retires the pin too (#935) — a pin on a task the
 * user has filed away is stale by definition, and the archived view collapses into one bucket
 * anyway, so a surviving pin would be invisible state waiting to surprise whoever unarchives.
 *
 * Here rather than in the pin route for the same reason `clearPendingAutoResume` is here: the
 * bulk "Archive finished" sweep never goes through a route, and it has to obey the rule too.
 *
 * Deleted, not set to `false`: absent is what every reader treats as unpinned, and it is the
 * shape a cezar that has never heard of pins already writes.
 */
function clearPin(run: RunRecord): void {
  delete run.pinned;
  delete run.pinnedAt;
}

function parseSeq(line: string): number | undefined {
  if (line.trim() === '') return undefined;
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq;
    return typeof seq === 'number' ? seq : undefined;
  } catch {
    return undefined;
  }
}

function eventTextFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const key of ['text', 'result', 'message'] as const) {
    const value = event[key];
    if (typeof value === 'string') fragments.push(value);
  }
  const item = event.item;
  if (item && typeof item === 'object' && (item as Record<string, unknown>).kind !== 'reasoning') {
    const it = item as Record<string, unknown>;
    for (const key of ['text', 'title', 'output'] as const) {
      const value = it[key];
      if (typeof value === 'string') fragments.push(value);
    }
    if (typeof it.input === 'string') {
      fragments.push(it.input);
    } else if (it.input !== undefined) {
      try {
        fragments.push(JSON.stringify(it.input).slice(0, MAX_TOOL_INPUT_HAYSTACK_CHARS));
      } catch {
        // circular input — skip it
      }
    }
  }
  return fragments;
}

/**
 * Where a CREATION CLAIM may come from — the trust boundary the created tier was missing.
 *
 * `CREATED_PR_RE` used to be matched against everything an event carried, tool OUTPUT included,
 * so a transcript that merely QUOTES a `gh pr create` line handed the run a PR it never opened.
 * Not hypothetical: the task that fixed the reference chips printed another run's stored events
 * while investigating them, and cezar read `"title": "Ran gh pr create --repo …"` out of that
 * dump and adopted a PR from a DIFFERENT repository as its own — permanently, because the first
 * created URL wins and the real `gh pr create` that followed was never looked at.
 *
 * So the claim must come from the agent's own words, or from the tool title cezar itself renders
 * from the command it saw run. Tool output and tool input are the transcript of the world, not a
 * statement about this run. The URL is still read from the whole event — `gh` prints it in the
 * output — because it is the CLAIM that needs a trustworthy source, not the link.
 */
function eventCreationClaimFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  // A `tool-result` event's `result` IS raw command output; on every other event the top-level
  // text is the agent's own.
  if (event.type !== 'tool-result') {
    for (const key of ['text', 'result', 'message'] as const) {
      const value = event[key];
      if (typeof value === 'string') fragments.push(value);
    }
  }
  const item = event.item;
  if (item && typeof item === 'object') {
    const it = item as Record<string, unknown>;
    if (it.kind === 'message' && it.role === 'assistant' && typeof it.text === 'string') {
      fragments.push(it.text);
    }
    if (it.kind === 'tool' && typeof it.title === 'string') fragments.push(it.title);
  }
  return fragments;
}

/** Agent-authored event text, matching the trust boundary used by task markers.
 * Tool titles, inputs, and outputs remain visible to the referenced-URL tier,
 * but must never promote an issue into the shared `issueNumber` field (#538). */
function eventAgentTextFragments(event: Record<string, unknown>): string[] {
  const fragments: string[] = [];
  for (const key of ['text', 'result'] as const) {
    const value = event[key];
    if (typeof value === 'string') fragments.push(value);
  }
  const item = event.item;
  if (item && typeof item === 'object') {
    const it = item as Record<string, unknown>;
    if (it.kind === 'message' && it.role === 'assistant' && typeof it.text === 'string') {
      fragments.push(it.text);
    }
  }
  return fragments;
}

/**
 * The referenced tier's resolution rule, shared by the PR and issue janitors:
 * a marker-declared number (spec 2026-07-18-task-ref-markers) owns the answer
 * outright — only a candidate URL ending in that number resolves, and a
 * contradiction clears the chip. Without a declaration: one distinct URL is
 * the subject; among several, the one whose number the task prompt names (and
 * only when exactly one matches); otherwise ambiguous — no chip beats a wrong
 * chip.
 *
 * Whatever that produces is then repo-scoped (#945): a winner from another repository that the
 * prompt does not corroborate is vetoed — see `isRepoScopedRef`. The veto is applied to the
 * RESULT rather than to the candidate list on purpose, so the guard stays strictly subtractive:
 * filtering first would let a project-local candidate win a two-candidate race today's rule calls
 * ambiguous, which is a wider behavior change than the defect warrants. As written this function
 * can only ever lose a value, never gain one.
 */
function resolveReferencedRef(
  candidates: string[],
  task: string,
  declared?: number,
  handle?: RepoHandle | null,
): string | undefined {
  const resolved = resolveCandidate(candidates, task, declared);
  if (resolved === undefined) return undefined;
  return isRepoScopedRef(resolved, task, handle) ? resolved : undefined;
}

/** The pre-#945 resolution rule, unchanged — see `resolveReferencedRef` for the contract. */
function resolveCandidate(candidates: string[], task: string, declared?: number): string | undefined {
  if (declared !== undefined) return candidates.find((url) => url.endsWith(`/${declared}`));
  if (candidates.length === 1) return candidates[0];
  const named = candidates.filter((url) => {
    const num = url.split('/').pop() ?? '';
    // `\d` boundaries only: they reject `170` inside `4170` yet still match a
    // number written as `#4170`, ` 4170`, or inside a pasted `…/pull/4170`.
    return num !== '' && new RegExp(`(?<!\\d)#?${num}(?!\\d)`).test(task);
  });
  return named.length === 1 ? named[0] : undefined;
}

/** The number a forge URL's last segment names (`…/pull/402` → 402), or undefined. */
function refUrlNumber(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const n = Number(url.split('/').pop());
  return Number.isInteger(n) && n > 0 && n < MAX_REF ? n : undefined;
}

const PR_REF_CAP = 8;
const PR_REF_RANK: Record<RunPrRef['origin'], number> = {
  created: 0,
  marker: 1,
  legacy: 2,
  derived: 3,
};

function legacyPrRefs(run: RunRecord): RunPrRef[] {
  const at = run.createdAt;
  const refs: RunPrRef[] = [];
  const created = refUrlNumber(run.pullRequestUrl);
  if (created !== undefined) refs.push({ number: created, url: run.pullRequestUrl, origin: 'created', at });
  const declared = run.markerRefs?.pr;
  const referenced = refUrlNumber(run.referencedPullRequestUrl);
  if (declared !== undefined) {
    refs.push({
      number: declared,
      ...(referenced === declared && run.referencedPullRequestUrl
        ? { url: run.referencedPullRequestUrl }
        : {}),
      origin: 'marker',
      at,
    });
  }
  else if (referenced !== undefined && referenced !== created) refs.push({ number: referenced, url: run.referencedPullRequestUrl, origin: 'legacy', at });
  if (run.prNumber !== undefined && !refs.some((ref) => ref.number === run.prNumber)) {
    refs.push({ number: run.prNumber, origin: 'derived', at });
  }
  return refs;
}

function primaryPrRef(refs: RunPrRef[]): RunPrRef | undefined {
  return refs.reduce<RunPrRef | undefined>((best, ref) =>
    !best || PR_REF_RANK[ref.origin] < PR_REF_RANK[best.origin] ? ref : best,
  undefined);
}

function appendPrRefToRun(run: RunRecord, ref: Omit<RunPrRef, 'at'> & { at?: string }): boolean {
  const hadList = !!run.prRefs;
  const refs = run.prRefs ?? legacyPrRefs(run);
  const at = ref.at ?? new Date().toISOString();
  const existing = refs.find(
    (candidate) =>
      candidate.number === ref.number &&
      (!candidate.url || !ref.url || candidate.url === ref.url),
  );
  let changed = !hadList;
  if (existing) {
    if (PR_REF_RANK[ref.origin] < PR_REF_RANK[existing.origin]) {
      existing.origin = ref.origin;
      changed = true;
    }
    if (!existing.url && ref.url) {
      existing.url = ref.url;
      changed = true;
    }
  } else {
    refs.push({ ...ref, at });
    changed = true;
    while (refs.length > PR_REF_CAP) {
      const primary = primaryPrRef(refs);
      const removable = refs.findIndex((candidate) => candidate !== primary && candidate.origin === 'derived');
      refs.splice(removable >= 0 ? removable : primary ? refs.findIndex((candidate) => candidate !== primary) : 0, 1);
    }
  }
  run.prRefs = refs;
  const primary = primaryPrRef(refs);
  const nextNumber = primary?.number;
  if (run.prNumber !== nextNumber) changed = true;
  if (nextNumber === undefined) delete run.prNumber;
  else run.prNumber = nextNumber;
  return changed;
}

/**
 * The PR declaration the REFERENCED tier is allowed to act on.
 *
 * `CEZ:PR=N` means one of two things depending on when the agent writes it: on the way in it
 * names the PR the task is ABOUT, and once the task has opened a PR of its own the marker
 * contract asks it to re-declare with the new number ("Re-emit with the new number if the subject
 * changes (e.g. you open a PR later in the task)"). A declaration naming the PR this run CREATED
 * is therefore a statement about the CREATED tier, which `pullRequestUrl` already carries — and
 * feeding it to the referenced tier ERASES the about-PR, because `resolveReferencedRef` clears
 * the chip when no candidate matches the declared number (a task on #4326 that opened
 * #5366 dropped from two chips to one the moment it declared #5366).
 *
 * Both tiers stay true instead: the created PR is the created PR, and the reference resolves as
 * if that declaration had not been made — which is exactly what it was before the task opened
 * anything.
 */
function referencedPrDeclaration(run: RunRecord): number | undefined {
  const declared = run.markerRefs?.pr;
  if (declared === undefined) return undefined;
  return declared === refUrlNumber(run.pullRequestUrl) ? undefined : declared;
}

/**
 * The PR URL a creation phrase *introduces*, or undefined. The created URL is
 * the first one at or after the `CREATED_PR_RE` phrase — a PR the same event
 * merely referenced *earlier* (e.g. the issue's own linked `…/pull/1`) must not
 * be mistaken for the one just created (#495). Falls back to the last URL
 * *before* the phrase for `gh` orderings that print the URL first. Selection
 * only — the caller decides whether creation phrasing is present.
 */
function createdPrUrl(haystack: string): string | undefined {
  const phrase = CREATED_PR_RE.exec(haystack);
  if (!phrase) return undefined;
  const after = PR_URL_RE.exec(haystack.slice(phrase.index));
  if (after) return after[0];
  let before: string | undefined;
  for (const m of haystack.slice(0, phrase.index).matchAll(new RegExp(PR_URL_RE.source, 'g'))) {
    before = m[0];
  }
  return before;
}

/**
 * Reconcile one record just read off disk with the fact that whichever process wrote it is gone.
 *
 * Mutates and returns `run`. Extracted from `RunStore.open` so the read-only index reader
 * (`./run-index.ts`) answers the SAME question about a `running` row on disk. Two parsers that
 * disagree here is a visible bug, not an internal one: the cockpit would show a task as running
 * in the ⌘K index and failed the moment you opened it.
 *
 * `keepLive` (#367): leave `queued`/`running`/`waiting` untouched so the caller can recover them
 * (RunManager.recover re-queues queued runs, resumes interrupted ones). Without it — one-shot CLI
 * paths that never recover, and the index reader, which has no manager at all — live-looking runs
 * are marked failed so no ghost stays behind.
 */
export function reconcileLoadedRun(run: RunRecord, opts?: { keepLive?: boolean }): RunRecord {
  // A run that was live when the previous process exited can never finish —
  // surface that instead of a forever-"running" ghost. `review` survives
  // restarts on purpose: the gate is pure data (worktree + branch + record)
  // with no live process, so the diff panel, Send back (resume) and Draft PR
  // all still work.
  if (
    !opts?.keepLive &&
    (run.status === 'running' || run.status === 'queued' || run.status === 'waiting')
  ) {
    // A run parked on an unanswered `CEZ:ASK` still owes the user that question — the same
    // answer `RunManager.recover()` gives, so this reader and the manager agree on "needs you".
    const askParked = run.status === 'waiting' && run.askParked === true;
    run.status = 'failed';
    run.error = 'interrupted — cezar process exited during the run';
    run.finishedAt = run.finishedAt ?? new Date().toISOString();
    // Stamped from `finishedAt`, so every cold read of the same record agrees on the instant.
    if (askParked) run.awaitingAnswerSince = run.finishedAt;
    for (const step of run.steps) {
      if (step.status === 'running' || step.status === 'waiting') step.status = 'failed';
    }
  }
  if (!['running', 'waiting', 'queued'].includes(run.status)) {
    run.activity = undefined;
    run.monitoringWakeAt = undefined;
  }
  // A pending usage-limit resume survives the restart on purpose (the wait can be
  // hours) — `RunManager.recover()` re-arms it from this field. It can only mean
  // anything on a `failed` run, so anywhere else it is stale bookkeeping.
  if (run.status !== 'failed') run.autoResumeAt = undefined;
  // Likewise an unanswered question only means anything on the `failed` run it stopped.
  if (run.status !== 'failed') run.awaitingAnswerSince = undefined;
  // The wake counter is intentionally process-local, so a restarted process
  // starts a fresh epoch instead of displaying a stale cap.
  run.monitoringWakeCapReached = undefined;
  // A mid-workflow ask park (#917) means nothing off a `waiting` run — including
  // the `failed` written just above for readers that do not recover.
  if (run.status !== 'waiting') run.askParked = undefined;
  // Heal a record written before `referencedPrDeclaration` existed: a task that re-declared
  // `CEZ:PR` with the PR it had just CREATED cleared the PR it was ABOUT, because no candidate
  // could match the created number. The evidence is all still on the record — only the
  // conclusion drawn from it was wrong — so re-resolve without that declaration instead of
  // asking for a migration. Deliberately one-directional: it only runs on a record that HAS no
  // referenced PR, so it can never take one away from a record written by an older cezar whose
  // candidate list no longer explains it. `prNumber` is not recoverable this way (the
  // declaration overwrote it) and is left alone — the restored URL is what paints the chip.
  if (
    run.referencedPullRequestUrl === undefined &&
    run.markerRefs?.pr !== undefined &&
    referencedPrDeclaration(run) === undefined
  ) {
    run.referencedPullRequestUrl = resolveReferencedRef(
      run.referencedPrCandidates ?? [],
      run.task,
      undefined,
    );
  }
  // Deliberately UNSCOPED by repo (#945), unlike every other `resolveReferencedRef` call. Neither
  // caller has a handle to pass: `RunStore.open` is synchronous and the handle costs a `gh` spawn
  // (which is why it is armed afterwards, by `setRepoHandle`), and the read-only index reader
  // (`./run-index.ts`) has no repo root at all. Passing `undefined` here is not a gap — it is the
  // no-handle path the guard is specified to take. The foreign-URL heal runs in `setRepoHandle`'s
  // sweep the moment the handle lands, and the index reader picks the healed values up from
  // `runs.json` on its next read.
  return run;
}

// Only paths whose owner has finished (or abandoned acquisition) enter this set.
// Never infer release from age: a paused active writer still owns it (see lockRunIndex).
const releasedIndexPaths = new Set<string>();
let indexCleanupTimer: NodeJS.Timeout | undefined;

function scheduleIndexCleanup(): void {
  if (indexCleanupTimer) return;
  indexCleanupTimer = setTimeout(() => {
    indexCleanupTimer = undefined;
    retryIndexCleanup();
  }, 100);
  indexCleanupTimer.unref();
}

function retryIndexCleanup(): void {
  for (const path of releasedIndexPaths) {
    try {
      rmSync(path, { force: true });
      releasedIndexPaths.delete(path);
    } catch { /* Keep ownership knowledge until I/O recovers. */ }
  }
  if (releasedIndexPaths.size) {
    // An idle owner must also unblock independent processes, without another local save.
    scheduleIndexCleanup();
  } else if (indexCleanupTimer) {
    clearTimeout(indexCleanupTimer);
    indexCleanupTimer = undefined;
  }
}

function releaseIndexPath(path: string): void {
  try { rmSync(path, { force: true }); } catch {
    releasedIndexPaths.add(path);
    // Schedule rather than retry immediately: repeated I/O failure must not hold up the
    // successful commit acknowledgment. There is no timer or extra I/O on healthy release.
    scheduleIndexCleanup();
  }
}

/** Linux `/proc/<pid>/stat` start time (field 22, clock ticks since boot); undefined where
 *  there is no procfs or the process is gone. Distinguishes a reused PID from its old owner. */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return value && /^\d+$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** This boot: Linux's `boot_id`, else the boot instant in seconds (`~<epoch>`, jittery). */
function bootIdentity(): string {
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (id) return id;
  } catch { /* no procfs */ }
  return `~${Math.round(Date.now() / 1000 - uptime())}`;
}

function sameBoot(a: string, b: string): boolean {
  if (a.startsWith('~') && b.startsWith('~')) return Math.abs(Number(a.slice(1)) - Number(b.slice(1))) <= 120;
  return a === b;
}

/** Linux PID namespace (`pid:[<inode>]`); undefined without procfs. Hostnames do not separate
 *  namespaces: `--network host`, k8s `hostNetwork` and WSL beside Windows share one. */
function pidNamespace(): string | undefined {
  try { return readlinkSync('/proc/self/ns/pid'); } catch { return undefined; }
}

/** A ticket from another process view, or one left unreadable, has no PID evidence; one older
 *  than this is a crash leftover (a writer holds its ticket for milliseconds), e.g. from before a container restart. */
const FOREIGN_TICKET_STALE_MS = 5 * 60_000;

const runIndexTicketSchema = z.object({
  n: z.number().int().nonnegative().safe(),
  host: z.string(),
  ns: z.string().optional(),
  boot: z.string().min(1),
  start: z.string().optional(),
}).strict();

/** Synchronous Lamport bakery lock for the local index. Each contender publishes a unique
 * ticket before choosing its number, then waits for choosing/earlier tickets. Unlike a timed
 * lease, a paused live writer never loses ownership midway through read/merge/rename. Unique
 * names also make dead-process cleanup safe: no successor can own the path being removed.
 * A live PID is not proof of a live writer: a crashed writer's PID is often reused, in a
 * container by the restarted cezar itself (#1434 review). A ticket is dead, without guessing
 * from age, when it is from an earlier boot; when it names this PID and thread but is not the
 * ticket this thread is taking (acquisition is synchronous); when its PID is gone; or, on
 * Linux, when its recorded process start time no longer matches. PIDs mean nothing in another
 * process view (hostname, PID namespace or boot-id format differs), so such a ticket is only
 * reaped once older than FOREIGN_TICKET_STALE_MS; any other live PID waits/fails.
 * Contention blocks the event loop for at most the 2 s cap, deliberately: writes are a
 * millisecond read/merge/rename by a handful of local cockpits, and a strict creation must
 * not acknowledge before the index is durable.
 * All participants must use this protocol on a coherent local filesystem.
 */
function lockRunIndex(dataDir: string): () => void {
  retryIndexCleanup();
  const directory = join(dataDir, 'runs', '.index-writers');
  mkdirSync(directory, { recursive: true });
  const name = `${process.pid}-${threadId}-${randomUUID()}.ticket`;
  const path = join(directory, name);
  const tmp = `${path}.tmp`;
  const deadline = performance.now() + 2_000;
  const self = { host: hostname(), ns: pidNamespace(), boot: bootIdentity(), start: processStartTime(process.pid) };
  const publish = (n: number) => {
    const ticket = { n, host: self.host, ...(self.ns ? { ns: self.ns } : {}), boot: self.boot, ...(self.start ? { start: self.start } : {}) };
    writeFileSync(tmp, JSON.stringify(ticket), { encoding: 'utf8', flag: 'wx' });
    renameSyncWithRetry(tmp, path);
  };
  // Measured against our own just-published ticket: one filesystem clock, not this process's.
  const abandoned = (other: string) => statSync(path).mtimeMs - statSync(other).mtimeMs > FOREIGN_TICKET_STALE_MS;
  const tickets = (): Array<[string, number]> => {
    const result: Array<[string, number]> = [];
    for (const other of readdirSync(directory)) {
      if (!/^\d+-[\da-f-]+\.ticket$/.test(other)) continue;
      const otherPath = join(directory, other);
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(readFileSync(otherPath, 'utf8')); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
        }
        const ticket = runIndexTicketSchema.safeParse(parsed);
        if (!ticket.success) {
          // Fail closed, unless power loss left it empty or torn long ago.
          if (other !== name && abandoned(otherPath)) { rmSync(otherPath, { force: true }); continue; }
          throw new Error(`Invalid run-index ticket ${otherPath}`);
        }
        const number = ticket.data.n;
        if (other !== name) {
          if (ticket.data.host !== self.host || ticket.data.ns !== self.ns
            || ticket.data.boot.startsWith('~') !== self.boot.startsWith('~')) {
            if (abandoned(otherPath)) rmSync(otherPath, { force: true });
            else result.push([other, number]);
            continue;
          }
          const [pidPart, threadPart] = other.split('-');
          const pid = Number(pidPart);
          let dead = !sameBoot(ticket.data.boot, self.boot) // an earlier boot
            || (pid === process.pid && threadPart === String(threadId)); // an earlier incarnation
          if (!dead) {
            try { process.kill(pid, 0); } catch (error) {
              // EPERM means alive but inaccessible. It must still exclude us.
              dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
            }
          }
          if (!dead && ticket.data.start !== undefined) {
            const current = processStartTime(pid);
            dead = current !== undefined && current !== ticket.data.start; // the PID was reused
          }
          if (dead) {
            rmSync(otherPath, { force: true });
            continue;
          }
        }
        result.push([other, number]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result;
  };
  try {
    publish(0); // choosing; visible before reading any other contender's ticket
    const number = Math.max(0, ...tickets().map(([, n]) => n)) + 1;
    if (!Number.isSafeInteger(number)) throw new Error('Run-index ticket overflow');
    publish(number);
    while (tickets().some(([other, n]) => other !== name &&
      (n === 0 || n < number || (n === number && other < name)))) {
      if (performance.now() >= deadline) throw new Error(`Timed out waiting for run-index writer (tickets in ${directory}; remove one only if its cezar is not running)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    return () => { releaseIndexPath(path); };
  } catch (error) {
    releaseIndexPath(path);
    releaseIndexPath(tmp);
    throw error;
  }
}

/**
 * File-backed run store: `runs.json` index (atomic tmp+rename writes, the
 * pattern from @cezar/core's IssueStore) plus one append-only NDJSON event
 * file per run. Also the in-process event bus the SSE endpoints subscribe to:
 * emits `('run', RunRecord)` and `('event', { runId, event: RunEvent })`.
 */
export class RunStore extends EventEmitter {
  private runs = new Map<string, RunRecord>();
  /** The backend of each run's latest session (`session.started`), naming its agent errors. */
  private sessionBackends = new Map<string, string>();
  /** Local snapshot at open/last successful save, for merging only our subsequent changes. */
  private persisted = new Map<string, string>();
  /** Ids this process removed on purpose — see `forget`, which is the only thing that writes it. */
  private forgotten = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  // Preserve failed-load evidence even after a later save rewrites the index. A workspace
  // summary must not call an owner that silently dropped records a complete empty project.
  private indexReadHealth: { state: 'complete' | 'unavailable'; omittedRuns: number; reason?: string } = { state: 'complete', omittedRuns: 0 };

  getIndexReadHealth() { return { ...this.indexReadHealth }; }

  /** `runs/` or an event file is unwritable: events stay live-only instead of failing every run. */
  private eventsUnwritable = false;

  /** The repository this project IS (#945), armed after `open()` by `setRepoHandle`. Undefined
   *  until it arrives and `null` when it cannot be known — both mean "unscoped", which is
   *  exactly the pre-#945 behavior. */
  private repoHandle: RepoHandle | null | undefined;

  private constructor(private readonly dataDir: string) {
    super();
    this.setMaxListeners(100);
  }

  /** See `reconcileLoadedRun` for what `keepLive` (#367) decides about live-looking rows. */
  static open(dataDir: string, opts?: { keepLive?: boolean }): RunStore {
    const store = new RunStore(dataDir);
    // An uncreatable data dir (EPERM: Windows Controlled Folder Access, a read-only checkout) must
    // not kill boot — the desktop shell relaunches into the same project every time (5af5aec6).
    try {
      mkdirSync(join(dataDir, 'runs'), { recursive: true });
    } catch (err) {
      store.eventsUnwritable = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cez] cannot create ${join(dataDir, 'runs')} (${message}); task history in this project will not be saved`);
    }
    const indexPath = join(dataDir, 'runs.json');
    if (existsSync(indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
        const parsed = z.array(runRecordSchema).safeParse(raw);
        if (parsed.success) {
          for (const run of parsed.data) {
            store.persisted.set(run.id, JSON.stringify(run));
            store.runs.set(run.id, reconcileLoadedRun(run, opts));
          }
          // Only behind an index that actually loaded — an unreadable one would orphan every layout.
          pruneOrphanLayouts(dataDir, new Set(store.runs.keys()), ORPHAN_LAYOUT_GRACE_MS);
        } else {
          store.indexReadHealth = { state: 'unavailable', omittedRuns: Array.isArray(raw) ? raw.length : 0, reason: 'Task index could not be loaded by this server' };
        }
      } catch {
        store.indexReadHealth = { state: 'unavailable', omittedRuns: 0, reason: 'Task index could not be loaded by this server' };
        // corrupt index — start fresh; event files stay on disk untouched
      }
    }
    return store;
  }

  /**
   * Tell the store which repository this project IS (#945), so the referenced tier stops adopting
   * another repo's PR/issue as the task's subject. See `isRepoScopedRef` for the rule.
   *
   * A setter rather than an `open()` option because `open()` is synchronous and the handle costs a
   * `gh` spawn: callers arm this in the background so boot never waits on the network. `null` is a
   * first-class answer meaning "cannot be known" (no `gh`, no remote, a non-git root) and leaves
   * the store in exactly its pre-#945 behavior.
   *
   * Arming also HEALS records already poisoned by the un-scoped rule, on the `reconcileLoadedRun`
   * precedent: the evidence is all still on the record (`referenced*Candidates`), only the
   * conclusion drawn from it was wrong, so re-deciding beats asking for a migration. It rewrites
   * values, never the format, and is one-directional by construction — see `rescopeRun`.
   */
  setRepoHandle(handle: RepoHandle | null): void {
    this.repoHandle = handle;
    if (!handle) return; // nothing to prove foreign against
    // `touch` per healed run: the cockpit is already live when the handle lands, so a corrected
    // chip has to reach the open page over SSE, not just the next `runs.json` write.
    for (const run of this.runs.values()) {
      if (this.rescopeRun(run)) this.touch(run);
    }
  }

  /**
   * Drop this run's referenced PR/issue if the project's handle proves it foreign and the prompt
   * does not corroborate it (#945). Returns whether anything changed.
   *
   * One-directional by construction: it only ever clears fields, so a record written by an older
   * cezar — or read by one after this ran — is never worse off, and a downgrade sees a record whose
   * format is untouched and whose cleared fields were already optional.
   */
  private rescopeRun(run: RunRecord): boolean {
    let changed = false;
    if (
      run.referencedPullRequestUrl &&
      !isRepoScopedRef(run.referencedPullRequestUrl, run.task, this.repoHandle)
    ) {
      run.referencedPullRequestUrl = undefined;
      changed = true;
    }
    if (
      run.referencedIssueUrl &&
      !isRepoScopedRef(run.referencedIssueUrl, run.task, this.repoHandle)
    ) {
      run.referencedIssueUrl = undefined;
      changed = true;
      // Take back the number this janitor seeded from that very URL — the same revoke
      // `trackReferencedIssues` performs when ambiguity clears a resolution. A `prNumber`-style
      // number the prompt, namer or a marker owns is NOT ours to touch, which is exactly what
      // `referencedIssueNumberSeeded` records.
      if (run.referencedIssueNumberSeeded) {
        run.issueNumber = undefined;
        run.referencedIssueNumberSeeded = undefined;
      }
    }
    return changed;
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Fresh durable evidence for receipt reconciliation; never replaces live in-memory runs. */
  listPersistedRuns(): RunRecord[] {
    try {
      return z.array(runRecordSchema).parse(JSON.parse(readFileSync(join(this.dataDir, 'runs.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Could not read persisted runs to verify automation delivery.');
    }
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  createRun(input: {
    id?: string;
    title: string;
    workflow: string;
    task: string;
    model?: string;
    runner?: RunnerId;
    /** Composer's per-task agent account (spec 2026-07-29-agent-profiles). */
    agentProfile?: string;
    generateFollowups?: boolean;
    autonomous?: boolean;
    worktree?: false;
    groupId?: string;
    variant?: string;
    steps: Array<Pick<StepState, 'id' | 'name' | 'kind'>>;
  }): RunRecord {
    const run: RunRecord = {
      id: input.id ?? randomUUID(),
      // Scrubbed on the way in, exactly as `updateRun` scrubs it on the way
      // through (#456 review) — a token pasted into the prompt otherwise sat
      // verbatim in `runs.json` from creation. `task` is deliberately NOT
      // scrubbed: it is the user's own prompt and is replayed into `{{task}}`
      // when a queued run is revived after a restart (#367), so redacting it
      // would corrupt the revived run.
      title: this.redactText(input.title),
      workflow: input.workflow,
      task: input.task,
      model: input.model,
      runner: input.runner,
      agentProfile: input.agentProfile,
      generateFollowups: input.generateFollowups,
      autonomous: input.autonomous,
      worktree: input.worktree,
      groupId: input.groupId,
      variant: input.variant,
      status: 'queued',
      createdAt: new Date().toISOString(),
      tokensUsed: 0,
      archived: false,
      steps: input.steps.map((s) => ({
        ...s,
        status: 'pending',
        iterations: 0,
        tokensUsed: 0,
      })),
    };
    // A prompt that pastes a PR or issue URL is already about that item — seed
    // both referenced tiers so queued runs can expose the reference before the
    // first agent event (#407, #554).
    this.trackReferencedPrs(run, input.task);
    this.trackReferencedIssues(run, input.task);
    this.runs.set(run.id, run);
    this.pruneOldRuns();
    this.touch(run);
    return run;
  }

  updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'steps'>>): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (Object.prototype.hasOwnProperty.call(patch, 'issueNumber')) {
      delete run.referencedIssueNumberSeeded;
    }
    const normalized = { ...patch };
    if (normalized.status && !['running', 'waiting', 'queued'].includes(normalized.status)) {
      normalized.activity = undefined;
      normalized.monitoringWakeAt = undefined;
      normalized.monitoringWakeCapReached = undefined;
    }
    // …and the mirror image for the usage-limit resume (spec
    // 2026-08-03-auto-resume-after-usage-limit): it is a promise made ABOUT a failed run, so a
    // run coming back to life — the resume itself, a user Continue, a re-queue — retires it.
    // The manager's timer re-checks the record before it fires, so a cleared field is enough.
    if (normalized.status && ['running', 'waiting', 'queued'].includes(normalized.status)) {
      normalized.autoResumeAt = undefined;
    }
    // The mid-workflow ask park (#917) is a flavour of `waiting` and nothing else:
    // answering it (`running`), cancelling, failing and settling all retire it, so
    // enforcing the invariant here spares every one of those callers the bookkeeping.
    if (normalized.status && normalized.status !== 'waiting') {
      normalized.askParked = undefined;
    }
    // An unanswered question belongs to the `failed` run its closed session left behind: the
    // Continue that answers it (`running`/`queued`), and every settlement, retire it.
    if (normalized.status && normalized.status !== 'failed') {
      normalized.awaitingAnswerSince = undefined;
    }
    // Seed the list from the old values BEFORE applying a patch. Callers that update a scalar
    // projection often provide the replacement URL/number in the same patch; seeding afterward
    // would make the historical association unrecoverable.
    if (!run.prRefs && !normalized.prRefs) run.prRefs = legacyPrRefs(run);
    // Counted on the transition only (#1438); an auto-resumed attempt failing again repeats a failure already counted.
    if (normalized.status === 'failed' && run.status !== 'failed' && run.autoResumeAttempts === undefined) {
      const kind = failureKind(normalized.error ?? run.error);
      if (kind) track('task_failed', { label: taskFailedLabel(run.runner, kind) });
    }
    Object.assign(run, this.redactPatch(normalized, id));
    // Keep legacy writers (including workflow resume/naming paths) in sync without requiring
    // every caller to know about the additive list. The list's provenance still decides the
    // compatibility scalar, so an inferred number cannot displace a declared/created one.
    if (normalized.pullRequestUrl) {
      const number = refUrlNumber(normalized.pullRequestUrl);
      if (number !== undefined) appendPrRefToRun(run, { number, url: normalized.pullRequestUrl, origin: 'created' });
    }
    if (normalized.prNumber !== undefined) {
      appendPrRefToRun(run, { number: normalized.prNumber, origin: 'derived' });
    }
    this.touch(run);
    return run;
  }

  /**
   * Scrub the free-text fields of a record patch (#427 review). Redacting only
   * events left a hole: `titleSummary` is derived from the RAW first agent turn
   * and `error` from raw process output, so a token the agent echoed was
   * `[REDACTED]` in the NDJSON yet verbatim in `runs.json` — the file the "no
   * secrets in state files" rule names explicitly. These three are the only
   * patch fields carrying agent/process text; the rest are ids, enums, counters
   * and URLs, and running the scrubber over them would only risk mangling them.
   *
   * `StepState.error` is the step-level counterpart and is scrubbed the same
   * way in `updateStep` — `run.ts` feeds the SAME `err.message` string to both
   * calls, so redacting only the run-level copy left the token verbatim one
   * field away (#456 review).
   */
  private redactPatch(
    patch: Partial<Omit<RunRecord, 'id' | 'steps'>>,
    runId: string,
  ): Partial<Omit<RunRecord, 'id' | 'steps'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    const out = { ...patch };
    for (const field of ['title', 'titleSummary', 'error'] as const) {
      const value = out[field];
      if (typeof value === 'string') out[field] = this.redactText(value, runId);
    }
    return out;
  }

  /**
   * Step-level counterpart of `redactPatch` (#456 review). `error` is the only
   * free-text `StepState` field — it is set from raw `err.message` /process
   * output (`run.ts` `finishStep`), and `touch()` fans the whole record out
   * over SSE, so an unscrubbed copy leaked to `runs.json` AND to the browser.
   * The remaining fields are ids, enums, counters and timestamps.
   */
  private redactStepPatch(patch: Partial<Omit<StepState, 'id'>>, runId: string): Partial<Omit<StepState, 'id'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    if (typeof patch.error !== 'string') return patch;
    return { ...patch, error: this.redactText(patch.error, runId) };
  }

  /** Append a step to an existing run (used by "Continue" — spec 003). */
  addStep(runId: string, step: Pick<StepState, 'id' | 'name' | 'kind'>): void {
    const run = this.runs.get(runId);
    if (!run || run.steps.some((s) => s.id === step.id)) return;
    run.steps.push({ ...step, status: 'pending', iterations: 0, tokensUsed: 0 });
    this.touch(run);
  }

  /**
   * Replace the step list of a run that has not started any step yet (#1078): a queued run whose
   * workflow changed on disk is re-resolved at dequeue, and the step rail must show the steps
   * that will actually run. Refused (returns false) once any step has left `pending`, so a run
   * with history can never have it rewritten.
   */
  replacePendingSteps(runId: string, steps: Array<Pick<StepState, 'id' | 'name' | 'kind'>>): boolean {
    const run = this.runs.get(runId);
    if (!run || run.steps.some((s) => s.status !== 'pending' || s.iterations > 0)) return false;
    run.steps = steps.map((s) => ({ ...s, status: 'pending', iterations: 0, tokensUsed: 0 }));
    this.touch(run);
    return true;
  }

  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void {
    const run = this.runs.get(runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;
    Object.assign(step, this.redactStepPatch(patch, runId));
    run.tokensUsed = run.steps.reduce((sum, s) => sum + s.tokensUsed, 0);
    const startedAgentSteps = run.steps.filter((candidate) => candidate.kind === 'agent' && candidate.iterations > 0);
    const directionalComplete =
      startedAgentSteps.length > 0 &&
      startedAgentSteps.every(
        (candidate) =>
          candidate.usageInvocationsStarted !== undefined &&
          candidate.usageInvocationsObserved !== undefined &&
          candidate.usageInvocationsObserved > 0 &&
          candidate.usageInvocationsStarted === candidate.usageInvocationsObserved &&
          candidate.usageTurnsStarted !== undefined &&
          candidate.usageTurnsRecorded !== undefined &&
          candidate.usageTurnsStarted > 0 &&
          candidate.usageTurnsStarted === candidate.usageTurnsRecorded &&
          candidate.inputTokens !== undefined &&
          candidate.outputTokens !== undefined,
      );
    run.inputTokens = directionalComplete
      ? startedAgentSteps.reduce((sum, candidate) => sum + (candidate.inputTokens ?? 0), 0)
      : undefined;
    run.outputTokens = directionalComplete
      ? startedAgentSteps.reduce((sum, candidate) => sum + (candidate.outputTokens ?? 0), 0)
      : undefined;
    const cost = run.steps.reduce((sum, s) => sum + (s.costUsd ?? 0), 0);
    // A reported zero is still a measurement; an unreported run is not free.
    run.costUsd = run.steps.some((s) => s.costUsd !== undefined) ? cost : undefined;
    this.touch(run);
  }

  setArchived(id: string, archived: boolean): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    run.archived = archived;
    run.archivedAt = archived ? new Date().toISOString() : undefined;
    if (archived) {
      clearPendingAutoResume(run);
      clearAwaitingAnswer(run);
      clearPin(run);
    }
    this.touch(run);
    return run;
  }

  /** Pin one run to the top of this project's task list, or unpin it (#935). Mirrors
   *  `setArchived`: sets the fields, then persists + broadcasts via `touch`, so the updated
   *  record rides the existing `run` SSE with no new event. Idempotent — re-pinning a pinned
   *  run just re-stamps `pinnedAt`.
   *
   *  Unconditional by design, like `setUnread`: pinning is legal for every status, and WHICH
   *  runs are worth offering the action on is UI policy (`runActionFlags` in the cockpit). */
  setPinned(id: string, pinned: boolean): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (pinned) {
      run.pinned = true;
      run.pinnedAt = new Date().toISOString();
    } else {
      clearPin(run);
    }
    this.touch(run);
    return run;
  }

  /** Bulk-archive every finished run; returns how many were archived. */
  archiveFinished(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      // An unanswered question is a gate, not an outcome — like `review`, the bulk sweep leaves it.
      if (
        !run.archived &&
        ['done', 'failed', 'cancelled'].includes(run.status) &&
        run.awaitingAnswerSince === undefined
      ) {
        run.archived = true;
        run.archivedAt = new Date().toISOString();
        clearPendingAutoResume(run);
        clearAwaitingAnswer(run);
        clearPin(run);
        this.touch(run);
        count++;
      }
    }
    return count;
  }

  /** Mark one run as read (#unread-done-items): stamp the read receipt now. Mirrors
   *  `setArchived` — sets the field then persists + broadcasts via `touch`, so the
   *  updated record rides the existing `run` SSE with no new event. Idempotent by
   *  design: opening an already-read thread just re-stamps a later `seenAt`. */
  setRead(id: string): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    run.seenAt = new Date().toISOString();
    this.touch(run);
    return run;
  }

  /** Mark one run as UNread (#775): drop the read receipt so the run rejoins the unread
   *  list. The inverse of `setRead` and, like it, `touch`es so the updated record rides the
   *  existing `run` SSE.
   *
   *  Deleting the field rather than adding a "manually unread" flag is the whole point:
   *  absent `seenAt` is ALREADY what every reader treats as unread (`isUnread` in the
   *  cockpit's read-state.ts, and `markAllRead`'s clause-for-clause copy of it below), so
   *  clearing needs no new state and writes a shape any older cezar already parses.
   *
   *  Deliberately unconditional: clearing a receipt is always a legal write, so this
   *  succeeds for an already-unread run (idempotent) and for statuses that can never wear
   *  the marker. WHETHER the action means anything for a given run is UI policy, and lives
   *  in the cockpit's `runActionFlags` — the same split the rest of the store keeps. */
  setUnread(id: string): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    delete run.seenAt;
    this.touch(run);
    return run;
  }

  /** Bulk mark-read: stamp every currently-unread finished run; returns the count.
   *  "Unread" here is the same rule the cockpit paints (`isUnread` in read-state.ts),
   *  clause for clause:
   *   - a `done` or `failed` run that finished and has not been seen since;
   *   - cancelled runs are never unread — you stopped them yourself;
   *   - archived ones never are either, since archiving is a stronger "done with this"
   *     than reading;
   *   - and a `failed` run with a pending `autoResumeAt` is not a done item AT ALL
   *     (`isScheduledResume`, spec 2026-08-03-auto-resume-after-usage-limit): it has an
   *     appointment to pick the work back up, so there is no outcome to have missed.
   *   - nor is a `failed` run still `awaitingAnswerSince` a question: it sits under
   *     "needs you", and its signal is that, not an unread outcome.
   *
   *  Keeping the two rules identical is what makes the returned count the number the
   *  cockpit's unread badge was showing. The `autoResumeAt` clause is the one that drifted
   *  (#803): `isUnread` gained it with auto-resume and this sweep did not, so a task waiting
   *  out a usage limit was uncounted by the badge but stamped read by the sweep — and this
   *  comment asserted an invariant the code no longer held.
   *
   *  This rule lives in two languages of the same repo, which is why it has now drifted
   *  once. The cockpit cannot import it (`packages/web` does not depend on the service, and
   *  should not), so a single definition would have to move to `packages/contract` — the one
   *  package both sides already import. Worth doing; deliberately not done here, because
   *  widening the contract package's remit from "shapes" to "behavior" is a design change
   *  that deserves its own review rather than riding along in a bug fix. Until then: EDIT
   *  BOTH, and the case-table tests on either side are what catch you if you don't. */
  markAllRead(): number {
    const now = new Date().toISOString();
    let count = 0;
    for (const run of this.runs.values()) {
      const unread =
        !run.archived &&
        (run.status === 'done' || run.status === 'failed') &&
        !(run.status === 'failed' && run.autoResumeAt !== undefined) &&
        !(run.status === 'failed' && run.awaitingAnswerSince !== undefined) &&
        run.finishedAt !== undefined &&
        (run.seenAt === undefined || run.seenAt < run.finishedAt);
      if (!unread) continue;
      run.seenAt = now;
      this.touch(run);
      count++;
    }
    return count;
  }

  private persistEvent(runId: string, event: RunEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    if (!this.eventsUnwritable) {
      try {
        appendFileSync(this.eventsPath(runId), line, 'utf8');
      } catch (err) {
        // Access denied mid-session (macOS privacy prompt, EPERM on the file) degrades like `open`
        // does: a throw here 500'd the message the user was sending (telemetry 73c6e796). Anything
        // else — a removed project's ENOENT (#1105) — still throws.
        if (!isAccessDenied(err)) throw err;
        this.eventsUnwritable = true;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cez] cannot write task history (${message}); events stay live-only until it is writable again`);
      }
      return;
    }
    // Degraded (already warned): retry, so access granted mid-session starts persisting.
    try {
      mkdirSync(join(this.dataDir, 'runs'), { recursive: true });
      appendFileSync(this.eventsPath(runId), line, 'utf8');
      this.eventsUnwritable = false;
    } catch {
      // live-only — the SSE stream still carries it
    }
  }

  appendEvent(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    this.drainStreamRedaction(runId, event);
    const seq = this.nextSeq(runId);
    // Scrub credentials before the event touches disk or the live wire (#427):
    // tool-result output is persisted verbatim and served back over the API, so
    // a secret in an agent's command output would otherwise land in `.ai/cezar/`.
    const full: RunEvent = this.redact({ ...event, seq, ts: new Date().toISOString() }, runId);
    // Sync append keeps event order without a write queue; local NDJSON
    // appends at agent-event rates are effectively free.
    this.persistEvent(runId, full);
    this.emit('event', { runId, event: full });
    if (full.type === 'session.started' && typeof full.backend === 'string') this.sessionBackends.set(runId, full.backend);
    // A new step or Continue may run another backend: the last session's no longer names it.
    if (full.type === 'step-start') this.sessionBackends.delete(runId);
    if ((full.type === 'error' || full.type === 'session.error') && typeof full.message === 'string') {
      // The step's backend is recorded before spawn, so it names a session that failed before
      // `session.started` too — a per-step runner or a Continue override, not `run.runner`.
      const stepBackend = run.steps.find((s) => s.id === full.stepId)?.backend;
      reportAgentError(stepBackend ?? this.sessionBackends.get(runId) ?? run.runner, {
        type: full.type,
        message: full.message,
        fatal: full.fatal,
      });
    }
    if (this.janitorSettled(run)) return full;

    // The janitor trick: agents print the PR URL after `gh pr create` — the
    // first one spotted in the transcript becomes the run's PR link. Scans v1
    // fields AND nested v2 `item.*` content (#407). A URL without the created
    // phrasing still feeds the referenced tier (the PR the task is about) —
    // and the phrasing itself is only believed from a source that can speak
    // FOR this run (`eventCreationClaimFragments`), never from quoted output.
    const haystack = eventTextFragments(full).join(' ');
    const agentHaystack = eventAgentTextFragments(full).join(' ');
    // The creation CLAIM is read from a narrower source than the URL is
    // (`eventCreationClaimFragments`), which is why the two are searched
    // together rather than the haystack alone: the phrase must land in the
    // trusted prefix, and the link may come from anywhere after it.
    const claim = eventCreationClaimFragments(full).join(' ');
    if (haystack.length > 0) {
      let changed = false;
      if (!run.pullRequestUrl) {
        const created = CREATED_PR_RE.test(claim) ? createdPrUrl(`${claim} ${haystack}`) : undefined;
        if (created) {
          this.updateRun(runId, { pullRequestUrl: created });
          this.recordPrRef(runId, { number: refUrlNumber(created)!, url: created, origin: 'created' });
          // Adopting the created tier can RELEASE a declaration the referenced tier was holding
          // (see `referencedPrDeclaration`), so re-resolve here too: the about-PR must come back
          // whether the marker arrived before the creation evidence or after it.
          const resolved = resolveReferencedRef(
            run.referencedPrCandidates ?? [],
            run.task,
            referencedPrDeclaration(run),
            this.repoHandle,
          );
          if (resolved !== run.referencedPullRequestUrl) {
            run.referencedPullRequestUrl = resolved;
            changed = true;
          }
        } else if (PR_URL_RE.test(haystack) && this.trackReferencedPrs(run, haystack)) {
          changed = true;
        }
      }
      // Issue links feed their own referenced tier regardless of PR state —
      // a task that created a PR can still be ABOUT an issue
      // (spec 2026-07-21-report-ref-discovery).
      if (
        ISSUE_URL_RE.test(haystack) &&
        this.trackReferencedIssues(run, haystack, agentHaystack)
      ) {
        changed = true;
      }
      if (changed) this.touch(run);
    }
    return full;
  }

  /**
   * True when no event can change the janitor's answer any more: the created PR is adopted, and the
   * issue working set is capped so `trackReferencedIssues` could only re-derive what it already
   * stored — except seeding `issueNumber`, which stays open while that field is empty.
   */
  private janitorSettled(run: RunRecord): boolean {
    return (
      run.pullRequestUrl !== undefined &&
      (run.referencedIssueCandidates?.length ?? 0) >= MAX_PR_CANDIDATES &&
      !(run.markerRefs?.issue === undefined && run.referencedIssueUrl && run.issueNumber === undefined)
    );
  }

  /**
   * Fold every PR URL in `haystack` into the run's referenced-tier working
   * set and re-resolve `referencedPullRequestUrl` (spec
   * 2026-07-16-pr-autodiscovery). Mutates the record in place — the caller
   * owns persistence/fan-out — and reports whether anything changed.
   */
  private trackReferencedPrs(run: RunRecord, haystack: string): boolean {
    const seen = new Set(run.referencedPrCandidates ?? []);
    const before = seen.size;
    for (const match of haystack.matchAll(new RegExp(PR_URL_RE.source, 'g'))) {
      if (seen.size >= MAX_PR_CANDIDATES) break;
      seen.add(match[0]);
    }
    if (seen.size === before) return false;
    run.referencedPrCandidates = [...seen];
    run.referencedPullRequestUrl = resolveReferencedRef(
      run.referencedPrCandidates,
      run.task,
      referencedPrDeclaration(run),
      this.repoHandle,
    );
    return true;
  }

  /**
   * The issue-side mirror of `trackReferencedPrs` (spec
   * 2026-07-21-report-ref-discovery): fold every issue URL in `haystack` into
   * the working set and re-resolve `referencedIssueUrl`. An unambiguous
   * resolution also seeds `issueNumber` when nothing owns that field yet —
   * marker and namer both outrank this janitor and overwrite it freely.
   */
  private trackReferencedIssues(
    run: RunRecord,
    haystack: string,
    seedHaystack = haystack,
  ): boolean {
    const seen = new Set(run.referencedIssueCandidates ?? []);
    const before = seen.size;
    for (const match of haystack.matchAll(new RegExp(ISSUE_URL_RE.source, 'g'))) {
      if (seen.size >= MAX_PR_CANDIDATES) break;
      seen.add(match[0]);
    }
    const candidatesChanged = seen.size !== before;
    if (candidatesChanged) run.referencedIssueCandidates = [...seen];
    const prev = run.referencedIssueUrl;
    run.referencedIssueUrl = resolveReferencedRef(
      run.referencedIssueCandidates ?? [],
      run.task,
      run.markerRefs?.issue,
      this.repoHandle,
    );
    let numberChanged = false;
    if (run.markerRefs?.issue === undefined && ISSUE_URL_RE.test(seedHaystack)) {
      if (run.referencedIssueUrl && run.issueNumber === undefined) {
        const n = Number(run.referencedIssueUrl.split('/').pop());
        if (Number.isInteger(n) && n > 0) {
          run.issueNumber = n;
          run.referencedIssueNumberSeeded = true;
          numberChanged = true;
        }
      } else if (!run.referencedIssueUrl && prev && run.referencedIssueNumberSeeded) {
        // Ambiguity revoked the resolution — take back the number this janitor
        // seeded from it. No chip beats a wrong chip.
        delete run.issueNumber;
        delete run.referencedIssueNumberSeeded;
        numberChanged = true;
      }
    }
    return candidatesChanged || run.referencedIssueUrl !== prev || numberChanged;
  }

  /**
   * Apply agent-declared reference markers (spec 2026-07-18-task-ref-markers).
   * Marker values are authoritative for the display tier: they overwrite the
   * regex/namer numbers, and a declared PR re-resolves the referenced URL
   * against the candidate working set — including down to `undefined` when no
   * candidate matches (a wrong chip is worse than no chip). The created tier
   * (`pullRequestUrl`) is deliberately untouched.
   *
   * One declaration is NOT a statement about the referenced tier: the number of the PR this run
   * itself created. See `referencedPrDeclaration` — the marker contract asks the agent to
   * re-declare after it opens a PR, and taking that literally cost the task the PR it was about.
   */
  applyMarkerRefs(runId: string, refs: { pr?: number; issue?: number }): RunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run || (refs.pr === undefined && refs.issue === undefined)) return run;
    run.markerRefs = {
      ...run.markerRefs,
      ...(refs.pr !== undefined ? { pr: refs.pr } : {}),
      ...(refs.issue !== undefined ? { issue: refs.issue } : {}),
    };
    // `prNumber` remains a compatibility projection; the ordered list decides which association
    // is primary, while `referencedPullRequestUrl` retains its existing marker semantics below.
    if (refs.pr !== undefined) this.recordPrRef(runId, { number: refs.pr, origin: 'marker' });
    if (refs.issue !== undefined) {
      run.issueNumber = refs.issue;
      delete run.referencedIssueNumberSeeded;
    }
    if (run.markerRefs.pr !== undefined) {
      run.referencedPullRequestUrl = resolveReferencedRef(
        run.referencedPrCandidates ?? [],
        run.task,
        referencedPrDeclaration(run),
        this.repoHandle,
      );
    }
    if (run.markerRefs.issue !== undefined) {
      run.referencedIssueUrl = resolveReferencedRef(
        run.referencedIssueCandidates ?? [],
        run.task,
        run.markerRefs.issue,
        this.repoHandle,
      );
    }
    this.touch(run);
    return run;
  }

  /** Record an authoritative PR association and recompute the compatibility scalar projection. */
  recordPrRef(runId: string, ref: Omit<RunPrRef, 'at'> & { at?: string }): RunRecord | undefined {
    const run = this.runs.get(runId);
    if (!run || !Number.isInteger(ref.number) || ref.number <= 0 || ref.number >= MAX_REF) return run;
    if (appendPrRefToRun(run, ref)) this.touch(run);
    return run;
  }

  /**
   * Fan an event out to live subscribers WITHOUT writing it to the NDJSON
   * file — the channel for coalesced `item.delta` flushes (protocol-v2
   * performance guardrail: raw deltas never hit disk; replay = the persisted
   * snapshots). Stamped with `seq`/`ts` like persisted lines so the live
   * wire keeps one ordering axis; the seq simply never appears in a replay
   * (gaps are fine — dedup compares with `>`).
   */
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    this.drainStreamRedaction(runId, event);
    const full: RunEvent = this.redact({ ...event, seq: this.nextSeq(runId), ts: new Date().toISOString() }, runId);
    this.emit('event', { runId, event: full });
    return full;
  }

  private readonly streamRedaction = new StreamRedaction();

  private drainStreamRedaction(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): void {
    for (const tail of this.streamRedaction.drain(runId, event)) {
      // Bypass transform: a terminal proper prefix must be released, not held again.
      const safe = process.env.CEZ_REDACT_SECRETS === '0' ? tail : redactDeep(tail, this.secretsForRun(runId));
      const full = { ...safe, seq: this.nextSeq(runId), ts: new Date().toISOString() };
      this.emit('event', { runId, event: full });
    }
  }

  /** Lazily-collected concrete secret values from the host env (#427). */
  private secretValues: readonly string[] | null = null;

  /**
   * Scrub known credential values / token shapes from an event before it is
   * persisted or fanned out. On by default; `CEZ_REDACT_SECRETS=0` opts out.
   */
  private redact(event: RunEvent, runId: string): RunEvent {
    if (process.env.CEZ_REDACT_SECRETS === '0') return event;
    const secrets = this.secretsForRun(runId);
    return redactDeep(this.streamRedaction.transform(runId, event, secrets), secrets) as RunEvent;
  }

  /** Best-effort scrub of one free-text string bound for `runs.json`. Honors
   *  the `CEZ_REDACT_SECRETS=0` opt-out itself so every caller inherits it. */
  private redactText(text: string, runId?: string): string {
    if (process.env.CEZ_REDACT_SECRETS === '0') return text;
    return redactSecrets(text, this.secretsForRun(runId));
  }

  /** Capture safe text before asynchronous derived work can outlive this run's registry. */
  redactRunText(runId: string, text: string): string { return this.redactText(text, runId); }

  private readonly runSecrets = new Map<string, readonly string[]>();

  /** Memory only: register before spawn; retain through the final event drain. */
  registerRunSecrets(runId: string, values: readonly string[]): void {
    if (values.length === 0) return;
    this.runSecrets.set(runId, [...new Set([...(this.runSecrets.get(runId) ?? []), ...values.filter(Boolean)])]
      .sort((a, b) => b.length - a.length));
  }

  clearRunSecrets(runId: string): void {
    this.runSecrets.delete(runId);
    this.streamRedaction.clear(runId);
  }

  private secretsForRun(runId?: string): readonly string[] {
    return [...this.hostSecrets(), ...(runId ? this.runSecrets.get(runId) ?? [] : [])]
      .sort((a, b) => b.length - a.length);
  }

  private hostSecrets(): readonly string[] {
    if (this.secretValues === null) this.secretValues = collectSecretValues();
    return this.secretValues;
  }

  readEvents(runId: string): RunEvent[] {
    try {
      const raw = readFileSync(this.eventsPath(runId), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as RunEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is RunEvent => e !== null);
    } catch {
      return [];
    }
  }

  deleteRun(id: string): boolean {
    const existed = this.forget(id);
    if (existed) {
      try {
        rmSync(this.eventsPath(id), { force: true });
        rmSync(this.handoffPath(id), { force: true }); // spec 007: the journal goes with the task
        rmSync(this.imagesDir(id), { recursive: true, force: true }); // agent screenshots
        // Unsent drafts go with the task (#939): a draft for a run that no longer exists is
        // unreachable by definition, and it may be holding megabytes of pasted screenshots.
        deleteRunDrafts(this.dataDir, id);
      } catch {
        // best effort — the index is authoritative
      }
      this.seqs.delete(id);
      this.scheduleSave();
      this.emit('deleted', id);
    }
    return existed;
  }

  /** Write the index out now. `flush()` is also a mid-run checkpoint (usage, automation launches),
   *  so indentation is opt-in: only a real shutdown passes `pretty`, leaving the hand-editable file
   *  the README promises behind a clean exit while every in-run save stays compact. */
  flush(options: { throwOnError?: boolean; pretty?: boolean } = {}): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow(options.throwOnError, options.pretty ?? false);
  }

  /** Commit a newly created run before queue admission. On a failed write, discard only
   *  our unpublished copy: no deletion tombstone or file removal, since another cockpit
   *  may subsequently retry the same reserved id. Call synchronously after creation. */
  flushCreatedRun(run: RunRecord): void {
    try {
      this.flush({ throwOnError: true });
      if (this.runs.get(run.id) !== run) {
        throw new Error('Could not persist automation run provenance; the launch was not confirmed.');
      }
    } catch (error) {
      if (this.runs.get(run.id) === run) {
        this.runs.delete(run.id);
        this.seqs.delete(run.id);
        this.emit('deleted', run.id);
      }
      throw error;
    }
  }

  // ---- internals -----------------------------------------------------------

  private seqs = new Map<string, number>();

  private nextSeq(runId: string): number {
    const next = (this.seqs.get(runId) ?? this.rehydrateSeq(runId)) + 1;
    this.seqs.set(runId, next);
    // The high-water mark rides whatever index save happens next — a status flip, a usage update,
    // the shutdown flush — rather than scheduling one per seq. An ephemeral `item.delta` stream
    // touches nothing else, so scheduling here would rewrite the whole index once a second for a
    // run whose transcript never changed; `rehydrateSeq` recovers the tail from disk on its own.
    const run = this.runs.get(runId);
    if (run) run.lastSeq = next;
    return next;
  }

  /** After a restart the in-memory counter is empty while the run's NDJSON file
   *  keeps the history. Restarting from 1 would collide with the seqs a client
   *  already replayed — its `seq > maxSeq` dedup then silently drops every
   *  resumed event, even across a reload (the frozen-transcript symptom class
   *  of #424). One file read on the first post-restart append per run. */
  private rehydrateSeq(runId: string): number {
    const persisted = this.runs.get(runId)?.lastSeq;
    if (persisted !== undefined) return Math.max(persisted, this.tailSeq(runId));
    let max = 0;
    for (const event of this.readEvents(runId)) {
      if (typeof event.seq === 'number' && event.seq > max) max = event.seq;
    }
    return max;
  }

  /** The `seq` of the last parseable line. Only trusted next to a persisted `lastSeq`: files from
   *  before it may carry a counter that restarted mid-file, so their maximum is not their tail. */
  private tailSeq(runId: string): number {
    let fd: number | undefined;
    try {
      fd = openSync(this.eventsPath(runId), 'r');
      let position = fstatSync(fd).size;
      let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      while (position > 0) {
        const length = Math.min(64 * 1024, position);
        position -= length;
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = readSync(fd, chunk, 0, length, position);
        const combined = Buffer.concat([chunk.subarray(0, bytesRead), tail]);
        let end = combined.length;
        while (end > 0) {
          const newline = combined.lastIndexOf(0x0a, end - 1);
          if (newline === -1 && position > 0) break;
          const seq = parseSeq(combined.subarray(newline + 1, end).toString('utf8'));
          if (seq !== undefined) return seq;
          end = Math.max(newline, 0);
        }
        tail = Buffer.from(combined.subarray(0, end));
      }
      return 0;
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private eventsPath(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}.ndjson`);
  }

  /** Same location `handoffPath()` in handoff.ts produces — inlined to keep
   *  the store free of upward imports. */
  private handoffPath(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}.handoff.md`);
  }

  /** Agent screenshots persisted by the run manager (see persistImage). */
  private imagesDir(runId: string): string {
    return join(this.dataDir, 'runs', `${runId}-images`);
  }

  private touch(run: RunRecord): void {
    this.scheduleSave();
    this.emit('run', run);
  }

  /** Forget a run, and remember that we did. Dropping it from the map is no longer enough on its
   *  own: `saveNow` unions the on-disk index back in, and the copy it re-reads is one THIS process
   *  wrote moments ago — so a plain `delete` would come straight back as a record whose event file
   *  `deleteRun` has already removed. A set of uuid strings that lives as long as the process,
   *  which is exactly how long a deletion has to outlive its own index entry. */
  private forget(id: string): boolean {
    this.forgotten.add(id);
    this.sessionBackends.delete(id);
    this.persisted.delete(id);
    return this.runs.delete(id);
  }

  /** A live run, and the dispatch parent/root of one, is never pruned: the run manager still
   *  writes to it, and evicting a long-lived parent while it dispatched threw `unknown run`
   *  (telemetry 73c6e796). The cap is a soft bound — live runs count toward it but never leave. */
  private pruneOldRuns(): void {
    const all = this.listRuns();
    const pinned = new Set<string>();
    for (const run of all) {
      if (!LIVE_STATUSES.has(run.status)) continue;
      pinned.add(run.id);
      if (run.dispatch?.parentRunId) pinned.add(run.dispatch.parentRunId);
      if (run.dispatch?.rootRunId) pinned.add(run.dispatch.rootRunId);
    }
    const stalePool = [
      ...all.filter((r) => !r.archived).slice(keepLimit('CEZ_RUNS_KEEP', DEFAULT_RUNS_KEPT)),
      ...all.filter((r) => r.archived).slice(keepLimit('CEZ_ARCHIVED_RUNS_KEEP', DEFAULT_ARCHIVED_KEPT)),
    ].filter((r) => !pinned.has(r.id));
    for (const stale of stalePool) {
      this.forget(stale.id);
      try {
        rmSync(this.eventsPath(stale.id), { force: true });
        rmSync(this.handoffPath(stale.id), { force: true });
        rmSync(this.imagesDir(stale.id), { recursive: true, force: true });
        deleteRunDrafts(this.dataDir, stale.id);
        deleteRunLayouts(this.dataDir, stale.id); // spec 2026-10-07-task-workspace §5.3
      } catch {
        // best effort
      }
    }
  }

  /** Debounced so token-usage updates don't rewrite the index per event. */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  private saveNow(throwOnError = false, pretty = false): void {
    const indexPath = join(this.dataDir, 'runs.json');
    const tmpPath = join(this.dataDir, 'runs', `.index-${process.pid}-${randomUUID()}.tmp`);
    let release: (() => void) | undefined;
    try {
      // Every caller (debounce, shutdown, ordinary flush and strict creation) takes the same
      // lock BEFORE reading. A unique temp protects payload identity but cannot prevent a
      // later rename from overwriting another writer's acknowledged additions.
      release = lockRunIndex(this.dataDir);
      const merged = this.mergeWithIndexOnDisk(indexPath);
      writeFileSync(tmpPath, JSON.stringify(merged, null, pretty ? 2 : undefined), 'utf8');
      renameSyncWithRetry(tmpPath, indexPath);
      // Do not reconcile/adopt foreign state into live manager-owned records. Remember our
      // local snapshot so future unchanged fields still defer to the latest persisted value.
      for (const [id, run] of this.runs) this.persisted.set(id, JSON.stringify(run));
    } catch (err) {
      if (throwOnError) throw new Error('Could not persist automation run provenance; the launch was not confirmed.');
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cez] failed to save runs.json: ${message}`);
    } finally {
      // Cleanup failure after a successful rename must not turn a durable creation into a
      // false failure/rollback. Failed own-ticket cleanup is retained and retried;
      // dead-process tickets are also reaped by the next writer.
      try { rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
      try { release?.(); } catch { /* best effort */ }
    }
  }

  /** Must run under lockRunIndex. Carry unknown runs through without recovery reconciliation,
   * and apply only locally changed fields to records we previously read. This keeps a stale
   * cockpit's unrelated flush from reverting another process's later update. Concurrent edits
   * to the same field use the last serialized writer; this is not execution ownership.
   * Local deletion tombstones still veto adoption. Absence alone is NOT a deletion signal:
   * older writers could have dropped our records. Cross-process deletion ownership requires a
   * separate durable tombstone protocol; it is not provided here. An unreadable index retains
   * the historical best-effort behavior of preserving our local records.
   */
  private mergeWithIndexOnDisk(indexPath: string): RunRecord[] {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { return this.listRuns(); }
    if (!Array.isArray(raw)) return this.listRuns();
    const merged = new Map<string, RunRecord>();
    for (const entry of raw) {
      const id: unknown = (entry as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || this.forgotten.has(id)) continue;
      const parsed = runRecordSchema.safeParse(entry);
      if (parsed.success) merged.set(id, parsed.data);
    }
    for (const mine of this.runs.values()) {
      const before = this.persisted.get(mine.id);
      const disk = merged.get(mine.id);
      if (!before || !disk || disk.createdAt !== mine.createdAt) {
        merged.set(mine.id, mine);
        continue;
      }
      const baseline = JSON.parse(before) as Record<string, unknown>;
      const local = mine as unknown as Record<string, unknown>;
      const combined = { ...disk } as unknown as Record<string, unknown>;
      for (const key of new Set([...Object.keys(baseline), ...Object.keys(local)])) {
        if (JSON.stringify(local[key]) === JSON.stringify(baseline[key])) continue;
        if (key in local) combined[key] = local[key];
        else delete combined[key];
      }
      merged.set(mine.id, combined as RunRecord);
    }
    return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
