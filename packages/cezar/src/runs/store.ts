import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { collectSecretValues, redactDeep, redactSecrets } from '../core/secret-redaction.ts';
// Pure, dependency-free reference helpers — the same sanity bound the marker parser applies.
import { MAX_REF } from './task-refs.ts';
// Type-only module (zod + nothing else), so this cannot cycle back into the store.
import { workflowDefSchema } from '../workflows/types.ts';

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
 * A runner id as it may appear in a PERSISTED record, normalized to the three
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
 * a fourth runner. The narrowing is one-way and permanent (the index is
 * re-serialized from the parsed records), which is what "old run records
 * normalise identically to `claude`" in `core/model-identity.ts` has always
 * claimed. Use ONLY for read-back of stored state — request bodies, settings and
 * workflow step defs stay the three selectable ids (`RunnerId`), because nothing
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
  status: z.enum(['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled']),
  /** Sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490):
   *  `monitoring` while the agent is still working on its own downstream work.
   *  Optional/absent on old runs; cleared when the run resumes or ends. */
  activity: z.enum(['monitoring']).optional(),
  /** Exact server-computed deadline for the next automatic monitoring check. */
  monitoringWakeAt: z.string().datetime().optional().catch(undefined),
  /** True only for the live epoch that exhausted all automatic monitoring checks. */
  monitoringWakeCapReached: z.boolean().optional(),
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
  /** The task's own branch (`cez/<id8>`), created off `baseBranch`. */
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
  /** Read receipt (#unread-done-items): the ISO time the cockpit last opened this
   *  run's thread. A finished run reads as "unread" until it has been seen since it
   *  finished — see `isUnread()` in the cockpit's `lib/read-state.ts`. Absent on old
   *  runs, on every run not yet opened, and on one `setUnread` put back to unread
   *  (#775) — the unread rule treats all three alike. */
  seenAt: z.string().optional(),
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

const MAX_RUNS_KEPT = 300;
const MAX_ARCHIVED_KEPT = 500;

const PR_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const ISSUE_URL_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/;
// The transcript auto-link is convenience only (the cockpit's own `gh pr create` path sets the
// URL authoritatively). Adopt a PR URL ONLY when the agent actually CREATED one — a task that
// reviews or merely references an existing PR must not get mislabeled with its number (#fake-pr).
const CREATED_PR_RE =
  /\b(?:gh\s+pr\s+create|pull\s*request\s+created|created\s+(?:a\s+)?(?:draft\s+)?(?:pr|pull\s*request)|opened\s+(?:a\s+)?(?:draft\s+)?pull\s*request)\b/i;

/** Referenced-tier working-set cap (spec 2026-07-16-pr-autodiscovery): past
 *  this many distinct PRs the conversation is a survey, not a subject. */
const MAX_PR_CANDIDATES = 8;

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
        fragments.push(JSON.stringify(it.input));
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
    run.status = 'failed';
    run.error = 'interrupted — cezar process exited during the run';
    run.finishedAt = run.finishedAt ?? new Date().toISOString();
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
  // The wake counter is intentionally process-local, so a restarted process
  // starts a fresh epoch instead of displaying a stale cap.
  run.monitoringWakeCapReached = undefined;
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

/**
 * File-backed run store: `runs.json` index (atomic tmp+rename writes, the
 * pattern from @cezar/core's IssueStore) plus one append-only NDJSON event
 * file per run. Also the in-process event bus the SSE endpoints subscribe to:
 * emits `('run', RunRecord)` and `('event', { runId, event: RunEvent })`.
 */
export class RunStore extends EventEmitter {
  private runs = new Map<string, RunRecord>();
  private saveTimer: NodeJS.Timeout | null = null;
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
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    const store = new RunStore(dataDir);
    const indexPath = join(dataDir, 'runs.json');
    if (existsSync(indexPath)) {
      try {
        const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
        const parsed = z.array(runRecordSchema).safeParse(raw);
        if (parsed.success) {
          for (const run of parsed.data) {
            store.runs.set(run.id, reconcileLoadedRun(run, opts));
          }
        }
      } catch {
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

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  createRun(input: {
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
      id: randomUUID(),
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
    Object.assign(run, this.redactPatch(normalized));
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
  ): Partial<Omit<RunRecord, 'id' | 'steps'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    const out = { ...patch };
    for (const field of ['title', 'titleSummary', 'error'] as const) {
      const value = out[field];
      if (typeof value === 'string') out[field] = this.redactText(value);
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
  private redactStepPatch(patch: Partial<Omit<StepState, 'id'>>): Partial<Omit<StepState, 'id'>> {
    if (process.env.CEZ_REDACT_SECRETS === '0') return patch;
    if (typeof patch.error !== 'string') return patch;
    return { ...patch, error: this.redactText(patch.error) };
  }

  /** Append a step to an existing run (used by "Continue" — spec 003). */
  addStep(runId: string, step: Pick<StepState, 'id' | 'name' | 'kind'>): void {
    const run = this.runs.get(runId);
    if (!run || run.steps.some((s) => s.id === step.id)) return;
    run.steps.push({ ...step, status: 'pending', iterations: 0, tokensUsed: 0 });
    this.touch(run);
  }

  updateStep(runId: string, stepId: string, patch: Partial<Omit<StepState, 'id'>>): void {
    const run = this.runs.get(runId);
    const step = run?.steps.find((s) => s.id === stepId);
    if (!run || !step) return;
    Object.assign(step, this.redactStepPatch(patch));
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
    run.costUsd = cost > 0 ? cost : undefined;
    this.touch(run);
  }

  setArchived(id: string, archived: boolean): RunRecord | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    run.archived = archived;
    run.archivedAt = archived ? new Date().toISOString() : undefined;
    if (archived) clearPendingAutoResume(run);
    this.touch(run);
    return run;
  }

  /** Bulk-archive every finished run; returns how many were archived. */
  archiveFinished(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!run.archived && ['done', 'failed', 'cancelled'].includes(run.status)) {
        run.archived = true;
        run.archivedAt = new Date().toISOString();
        clearPendingAutoResume(run);
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
        run.finishedAt !== undefined &&
        (run.seenAt === undefined || run.seenAt < run.finishedAt);
      if (!unread) continue;
      run.seenAt = now;
      this.touch(run);
      count++;
    }
    return count;
  }

  appendEvent(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const seq = this.nextSeq(runId);
    // Scrub credentials before the event touches disk or the live wire (#427):
    // tool-result output is persisted verbatim and served back over the API, so
    // a secret in an agent's command output would otherwise land in `.ai/cezar/`.
    const full: RunEvent = this.redact({ ...event, seq, ts: new Date().toISOString() });
    // Sync append keeps event order without a write queue; local NDJSON
    // appends at agent-event rates are effectively free.
    appendFileSync(this.eventsPath(runId), `${JSON.stringify(full)}\n`, 'utf8');
    this.emit('event', { runId, event: full });

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
    // `prNumber` is the about-PR as well (it is what paints a numeric-only chip), so a
    // re-declaration naming the created PR only FILLS it — it never overwrites the number the
    // task came in with, which is still the PR this task is about.
    if (refs.pr !== undefined && (run.prNumber === undefined || refs.pr !== refUrlNumber(run.pullRequestUrl))) {
      run.prNumber = refs.pr;
    }
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

  /**
   * Fan an event out to live subscribers WITHOUT writing it to the NDJSON
   * file — the channel for coalesced `item.delta` flushes (protocol-v2
   * performance guardrail: raw deltas never hit disk; replay = the persisted
   * snapshots). Stamped with `seq`/`ts` like persisted lines so the live
   * wire keeps one ordering axis; the seq simply never appears in a replay
   * (gaps are fine — dedup compares with `>`).
   */
  emitEphemeral(runId: string, event: { type: string; stepId?: string; [key: string]: unknown }): RunEvent {
    const full: RunEvent = this.redact({ ...event, seq: this.nextSeq(runId), ts: new Date().toISOString() });
    this.emit('event', { runId, event: full });
    return full;
  }

  /** Lazily-collected concrete secret values from the host env (#427). */
  private secretValues: readonly string[] | null = null;

  /**
   * Scrub known credential values / token shapes from an event before it is
   * persisted or fanned out. On by default; `CEZ_REDACT_SECRETS=0` opts out.
   */
  private redact(event: RunEvent): RunEvent {
    if (process.env.CEZ_REDACT_SECRETS === '0') return event;
    return redactDeep(event, this.hostSecrets());
  }

  /** Best-effort scrub of one free-text string bound for `runs.json`. Honors
   *  the `CEZ_REDACT_SECRETS=0` opt-out itself so every caller inherits it. */
  private redactText(text: string): string {
    if (process.env.CEZ_REDACT_SECRETS === '0') return text;
    return redactSecrets(text, this.hostSecrets());
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
    const existed = this.runs.delete(id);
    if (existed) {
      try {
        rmSync(this.eventsPath(id), { force: true });
        rmSync(this.handoffPath(id), { force: true }); // spec 007: the journal goes with the task
        rmSync(this.imagesDir(id), { recursive: true, force: true }); // agent screenshots
      } catch {
        // best effort — the index is authoritative
      }
      this.seqs.delete(id);
      this.scheduleSave();
      this.emit('deleted', id);
    }
    return existed;
  }

  /** Write the index out now (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }

  // ---- internals -----------------------------------------------------------

  private seqs = new Map<string, number>();

  private nextSeq(runId: string): number {
    const next = (this.seqs.get(runId) ?? this.rehydrateSeq(runId)) + 1;
    this.seqs.set(runId, next);
    return next;
  }

  /** After a restart the in-memory counter is empty while the run's NDJSON file
   *  keeps the history. Restarting from 1 would collide with the seqs a client
   *  already replayed — its `seq > maxSeq` dedup then silently drops every
   *  resumed event, even across a reload (the frozen-transcript symptom class
   *  of #424). One file read on the first post-restart append per run. */
  private rehydrateSeq(runId: string): number {
    let max = 0;
    for (const event of this.readEvents(runId)) {
      if (typeof event.seq === 'number' && event.seq > max) max = event.seq;
    }
    return max;
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

  private pruneOldRuns(): void {
    const all = this.listRuns();
    const stalePool = [
      ...all.filter((r) => !r.archived).slice(MAX_RUNS_KEPT),
      ...all.filter((r) => r.archived).slice(MAX_ARCHIVED_KEPT),
    ];
    for (const stale of stalePool) {
      this.runs.delete(stale.id);
      try {
        rmSync(this.eventsPath(stale.id), { force: true });
        rmSync(this.handoffPath(stale.id), { force: true });
        rmSync(this.imagesDir(stale.id), { recursive: true, force: true });
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
    }, 300);
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    const indexPath = join(this.dataDir, 'runs.json');
    const tmpPath = `${indexPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.listRuns(), null, 2), 'utf8');
      renameSync(tmpPath, indexPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cez] failed to save runs.json: ${message}`);
    }
  }
}
