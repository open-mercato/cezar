/**
 * The shape of the cockpit's HTTP surface (`src/server/server.ts`), hand-mirrored for the
 * browser bundle.
 *
 * Why a mirror and not an import: the server is Node ESM under NodeNext (`.js` relative
 * specifiers, `node:*` imports, zod at runtime). Importing its modules here would either drag
 * Node built-ins into the bundle or force two module-resolution modes into one file. The types
 * are the contract; the code behind them is not.
 *
 * The mirror is *checked*, not trusted: `src/server/api-types.test.ts` asserts type-exactness
 * between these declarations and the server's own (it is a server test on purpose — that is the
 * suite `npm run typecheck` and `npm test` both cover, so drift fails the gate rather than
 * hiding until runtime). Anything below without a guard there carries a real drift risk; keep
 * the guard list in step with this file.
 *
 * This module MUST stay import-free so the guard can reach it from the NodeNext side.
 */

// ---- runs (src/runs/store.ts) ------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'waiting' | 'review' | 'done' | 'failed' | 'cancelled'

/** Sub-state of `running` (spec 2026-07-18-subagent-monitoring-status, #490): the agent is
 *  still working on its own downstream work (a sub-agent / a monitored command), not on you. */
export type RunActivity = 'monitoring'

export type StepStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped'

/** The agent backends a run can use. `runner` is optional on old records — they predate the
 *  choice and are Claude by definition (see `resumeCommand` in the server). */
export type Runner = 'claude' | 'codex' | 'opencode'

/** Coarse host authentication state from `/api/providers/status`. Credentials, account
 *  identity, and raw CLI output never cross this boundary. */
export type ProviderId = Runner
export type ProviderConnectionState =
  | 'connected'
  | 'disconnected'
  | 'not-installed'
  | 'unknown'

export interface ProviderStatus {
  provider: ProviderId
  status: ProviderConnectionState
  enabled: boolean
  hint?: string
  authFailureId?: string
}

export interface ProviderStatusResponse {
  providers: ProviderStatus[]
}

export type ProviderConnectResponse =
  | { opened: true; command: string }
  | { opened: false; connected: true; command: string }

export interface RunnerModelOption {
  id: string
  label: string
  description: string
}

export interface RunnerModelCatalogResponse {
  runner: Runner
  models: RunnerModelOption[]
  source: 'live' | 'cache' | 'unavailable'
  stale: boolean
  reason?: string
}

export interface StepState {
  id: string
  name: string
  kind: 'agent' | 'check'
  status: StepStatus
  iterations: number
  tokensUsed: number
  startedAt?: string
  finishedAt?: string
  error?: string
  /** Latest agent session id — `claude --resume <id>` and friends. */
  sessionId?: string
  /** Backend that owns `sessionId`; absent on records written before backend affinity. */
  backend?: Runner
  costUsd?: number
}

/** Aggregate diff numbers of a run's worktree vs its base (#389). */
export interface DiffStat {
  adds: number
  dels: number
  files: number
}

export interface RunRecord {
  id: string
  title: string
  /** Display title (#389): auto-derived from the first agent turn, or the user's inline edit
   *  (`PATCH /api/runs/:id` sets it together with `title`). Show `titleSummary ?? title`. */
  titleSummary?: string
  /** Refreshed on every turn-end; absent until the first turn ends (and on worktree-less runs). */
  diffStat?: DiffStat
  workflow: string
  task: string
  /** URLs of images attached to the initial task prompt (#image-display). */
  taskImages?: string[]
  /** Prompt messages stacked onto the run while it waits for a free agent slot (#472).
   *  Folded into the prompt at dequeue — never delivered as their own turns. Editable and
   *  removable only while `status === 'queued'`. Absent on every pre-#472 run. */
  queuedMessages?: QueuedMessage[]
  model?: string
  /** Normalized provider/model identity used for attribution and reproducible replay. */
  modelIdentity?: string
  runner?: Runner
  /** Echo of the extra system prompt the run used (POST override or config default). */
  systemPrompt?: string
  /** false when the run deliberately disabled follow-up todo generation. Absent means enabled. */
  generateFollowups?: boolean
  status: RunStatus
  /** `monitoring` while `status === 'running'` and the agent is working on downstream work
   *  (spec 2026-07-18-subagent-monitoring-status, #490). Absent on old runs; cleared on resume/end. */
  activity?: RunActivity
  /** Exact ISO-8601 deadline for the next automatic monitoring check. */
  monitoringWakeAt?: string
  /** The current live monitoring epoch exhausted its 40 automatic checks. */
  monitoringWakeCapReached?: boolean
  createdAt: string
  startedAt?: string
  finishedAt?: string
  tokensUsed: number
  costUsd?: number
  pullRequestUrl?: string
  /** The PR this task is ABOUT (#407) — auto-discovered from conversation references.
   *  Display tier only: `pullRequestUrl` (the PR this task CREATED) wins, and the
   *  Draft-PR / Create-PR action gates ignore it. Read via `taskPrUrl()`. */
  referencedPullRequestUrl?: string
  /** The PR/issue number this task is ABOUT (task auto-naming spec) — display tier only. */
  prNumber?: number
  issueNumber?: number
  /** Server-side provenance: referenced-issue discovery currently owns `issueNumber`. */
  referencedIssueNumberSeeded?: boolean
  /** 'user' = renamed via PATCH, never auto-overwritten; 'marker' = agent-declared
   *  via CEZ:TITLE (spec 2026-07-18-task-ref-markers); 'auto' = namer-owned. */
  titleOrigin?: 'user' | 'auto' | 'marker'
  /** References the agent declared via CEZ:PR/CEZ:ISSUE markers — authoritative
   *  over the namer for the matching kind. */
  markerRefs?: { pr?: number; issue?: number }
  /** The referenced tier's working set (distinct PR URLs spotted, capped server-side). */
  referencedPrCandidates?: string[]
  /** The issue this task is ABOUT (spec 2026-07-21-report-ref-discovery): auto-discovered from
   *  `github.com/…/issues/N` links in the conversation. Display-only; never gates actions. */
  referencedIssueUrl?: string
  /** The referenced-issue working set, persisted like `referencedPrCandidates`. Capped. */
  referencedIssueCandidates?: string[]
  /** Autonomous mode (#autonomous): the run never parks at `waiting` or the terminal `review`
   *  gate. Absent = falsy = not autonomous. */
  autonomous?: boolean
  /** Absent when the run executed in the repo working tree rather than its own worktree. */
  worktreePath?: string
  /** Set when count-based retention (#483) reclaimed the worktree DIRECTORY (the branch is
   *  kept): the dir is gone but recoverable, and the run is out of the retention budget until
   *  it is re-materialized. */
  worktreeReclaimedAt?: string
  branch?: string
  baseBranch?: string
  /** Parallel variants (spec 010): runs sharing a groupId are one group. */
  groupId?: string
  /** Variant letter within the group — 'A' | 'B' | 'C'. */
  variant?: string
  peakRssBytes?: number
  peakProcCount?: number
  archived: boolean
  archivedAt?: string
  currentStepId?: string
  error?: string
  steps: StepState[]
  /** Persisted workflow definition; kept loose server-side, so loose here too. */
  workflowDef?: Record<string, unknown>
}

/** One aggregated sample of a run's live process tree (src/core/process-usage.ts). */
export interface ProcessUsage {
  cpuPct: number
  rssBytes: number
  procCount: number
}

/**
 * What `GET /api/runs` and `GET /api/runs/:id` actually answer: the stored record plus the
 * live `usage` sample the server attaches on the way out (`withUsage`). Absent for finished
 * runs and wherever `ps` yields nothing — never persisted.
 */
export type ApiRun = RunRecord & { usage?: ProcessUsage }

/**
 * One line of a run's NDJSON transcript. `type` mirrors the agent events plus engine
 * lifecycle, and the payload keys vary by type — hence the index signature. `seq` is the
 * dedup key the reducers key on (Step 3.2).
 */
export interface RunEvent {
  seq: number
  ts: string
  stepId?: string
  type: string
  [key: string]: unknown
}

// ---- parallel variants (spec 010, `GET /api/groups/:groupId`) ------------------------------

/**
 * One variant column of the compare view. CAREFUL: `diffStat` here is the raw `git diff --stat`
 * TEXT the server runs in the variant's worktree (legacy compare semantics) — a different thing
 * from the numeric `RunRecord.diffStat`. `''` when the worktree is gone.
 */
export interface GroupVariant {
  id: string
  /** 'A' | 'B' | 'C' in practice; `'?'` for a record that lost its letter. */
  variant: string
  title: string
  status: RunStatus
  archived: boolean
  tokensUsed: number
  costUsd?: number
  diffStat: string
  /** First lines of the handoff journal's "## Progress log" section, as markdown. */
  handoffExcerpt: string
}

export interface GroupResponse {
  groupId: string
  runs: GroupVariant[]
}

/** `POST /api/groups/:groupId/pick` — the winner (parked at `review` when it has a diff);
 *  the losers were cancelled if alive, archived, and their worktrees + branches removed. */
export interface PickVariantResponse {
  winner?: RunRecord
}

// ---- health / environment (src/core/backend-detect.ts, src/server/git.ts) -----------------

export interface BackendCheck {
  name: 'claude' | 'codex' | 'opencode' | 'gh' | 'git'
  available: boolean
  version?: string
  /** Human setup hint — shown verbatim; the server writes these for people, not for parsing. */
  hint?: string
}

export interface RepoInfo {
  root: string
  branch: string
  remote?: string
}

/** How `/api/health` serializes the resolved forge driver (R5, src/server/forge/):
 *  `{ kind, ...detect() }`. Null means plain-git features only — no PR/issue surfaces. */
export interface ForgeInfo {
  kind: 'github'
  available: boolean
  /** Human-readable hint when unavailable (`gh` missing, offline…). */
  reason?: string
}

/** Server capabilities (src/server/capabilities.ts). `localHandoff: false` means
 *  hosted mode (`CEZ_REMOTE` / non-loopback bind) — every open-on-my-machine affordance
 *  (Terminal, editor, `cd …` hints) must disappear, not disable.
 *  `followups: false` (the default — the inbox is opt-in via `CEZ_FOLLOWUPS=1`, #471) means
 *  this server has no follow-up inbox: the Inbox nav item and the composer's follow-up
 *  toggle disappear the same way. The per-task handoff journal is unrelated and always on.
 *  `singleProject: true` means `CEZ_SINGLE_PROJECT=1` constrained the workspace to its
 *  launch project and all multi-project affordances must be omitted. */
export interface Capabilities {
  localHandoff: boolean
  followups: boolean
  singleProject: boolean
}

export interface HealthResponse {
  version: string
  /** Only once the npm-registry check answers with something newer (#368). */
  latestVersion?: string
  repoRoot: string
  /** Null when cezar was started outside a git repository. */
  repo: RepoInfo | null
  checks: BackendCheck[]
  defaultRunner: Runner
  /** R5 additive fields (BACKWARD_COMPATIBILITY.md §2 keeps the pre-forge shape intact). */
  forge: ForgeInfo | null
  capabilities: Capabilities
  /** Multi-project additive fields (step 1.6): the registered projects — id + name ONLY, never
   *  roots (health is the one CORS-open route) — and the id of the project cezar booted in.
   *  `bootProject` is what the workspace-events filter compares stamps against when unscoped. */
  projects?: { id: string; name: string }[]
  bootProject?: string
}

/** One `GET /api/projects` registry entry (multi-project spec, step 1.6). Unlike health's
 *  id+name pairs this carries absolute `root`s — same-origin only, never the CORS-open route. */
export interface ProjectListEntry {
  id: string
  name: string
  root: string
  addedAt: string
  lastOpenedAt: string
  source: 'local' | 'checkout'
  /** `not-git` is fully usable (degraded single-queue mode); only `missing` blocks. */
  status: 'ok' | 'missing' | 'not-git'
  /** Current branch when cheaply available (omitted e.g. on an unborn HEAD). */
  branch?: string
  /** Per-project cap on concurrently running tasks (spec 2026-07-22). Omitted =
   *  inherit the workspace `resources.maxParallel`; a number pins this project. */
  maxParallel?: number
}

/** `GET /api/projects` — the workspace registry. Workspace-level: never 404s, never scoped. */
export interface ProjectsResponse {
  projects: ProjectListEntry[]
  bootProject: string
  projectsDir: string
}

/** `POST /api/projects` (multi-project spec, step 4.2) — what the folder-browser dialog gets
 *  back. `error` is present ONLY on the 409 (already registered), where `project` is the
 *  EXISTING entry: the dialog navigates to it rather than dead-ending on a duplicate. */
export interface RegisterProjectResponse {
  project: ProjectListEntry
  error?: string
}

/** `DELETE /api/projects/:projectId` (multi-project spec, step 4.4) — Settings → Projects'
 *  per-row Remove. Deregistration ONLY: the server never touches anything under the project
 *  root, so this is a registry edit and nothing else. The interesting failures are 409s (the
 *  project has running tasks, or it is the project this server booted in), whose `{ error }`
 *  the pane shows verbatim. */
export interface RemoveProjectResponse {
  removed: true
  id: string
}

/** `PATCH /api/projects/:projectId` (spec 2026-07-22-per-project-concurrency) — set or clear a
 *  project's per-project concurrency ceiling. `null` clears the override back to "inherit the
 *  workspace cap"; an integer `1..16` pins it. */
export interface UpdateProjectInput {
  maxParallel: number | null
}

/** `PATCH /api/projects/:projectId` — the updated entry, same shape `GET /api/projects` attaches. */
export interface UpdateProjectResponse {
  project: ProjectListEntry
}

/** `POST /api/projects/checkout` (multi-project spec, step 4.3) — the clone-from-GitHub body.
 *  `name` defaults server-side to the repo name; `checkoutId` is the cockpit's own correlation
 *  token, echoed on every `checkout-progress` event so two tabs cloning at once never render
 *  each other's progress. */
export interface CheckoutProjectInput {
  url: string
  name?: string
  checkoutId?: string
}

/** One `checkout-progress` workspace SSE payload (step 4.3). `cloning` carries one line of
 *  `git clone` output; `done`/`error` are terminal. The dialog shows `error` VERBATIM — a
 *  clone fails for reasons (auth, network, a typo'd repo) only the server can name. */
export interface CheckoutProgressEvent {
  checkoutId?: string
  name: string
  phase: 'cloning' | 'done' | 'error'
  line?: string
  error?: string
}

/** One directory in a `GET /api/fs/browse` listing (multi-project spec, step 4.1). `path` is
 *  absolute — same-origin route, like `ProjectListEntry.root`. */
export interface FsBrowseDir {
  name: string
  path: string
  /** Has a `.git` entry — drives the "git" badge. A non-repo folder is still selectable
   *  (cezar degrades in a non-git folder exactly as `cezar serve` does today). */
  isRepo: boolean
}

/** `GET /api/fs/browse?path=` — the folder picker's listing. Rooted at the independently
 *  configured browse root, directories only. */
export interface FsBrowseResponse {
  /** The realpath'd directory actually listed — never the spelling asked for, so the
   *  breadcrumb shows where the picker really is. */
  path: string
  /** `null` AT the browse root: there is no "up" out of it, and the dialog must render no
   *  parent row rather than one that 400s. */
  parent: string | null
  dirs: FsBrowseDir[]
  /** True when the listing was capped server-side — surfaced honestly instead of showing a
   *  silently short list. */
  truncated: boolean
}

/** `GET/PUT /api/workspace/ui-state` — cross-project GUI prefs in `~/.cezar/ui-state.json`
 *  (multi-project spec, step 2.7). Passthrough like its per-repo twin (`UiState` below):
 *  unknown keys round-trip untouched. `sidebar.collapsed` is the sidebar's per-project
 *  collapse map (step 3.3) — `true` collapses a group, `false` pins it open, absent means
 *  the default (the active project expands, the rest collapse). The PUT merges SHALLOWLY at
 *  the top level server-side, so a writer must send the whole `sidebar` object, not a leaf. */
export interface WorkspaceUiState {
  sidebar?: { collapsed?: Record<string, boolean> } & Record<string, unknown>
  /** Dismissed runtime-auth incident IDs, keyed by provider. An ID is only dismissed until
   *  the provider reports a different incident, so this stays workspace-global with the
   *  browser rather than one project checkout. */
  dismissedProviderAuthFailures?: Partial<Record<ProviderId, string>>
  /** Settings → Appearance, GLOBAL since step 3.5: accent + density describe the person at
   *  the keyboard, not a repo, so they live in `~/.cezar/ui-state.json` and follow the user
   *  across every project. Same shape as the per-repo `UiState.appearance` it superseded
   *  (Migration 001 copied the old per-repo value up). */
  appearance?: { accent?: 'lime' | 'violet'; density?: 'comfortable' | 'compact' | 'ultra' }
  /** Settings → Notifications, GLOBAL since step 3.5 — one answer for the whole workspace,
   *  since the delivering browser is one browser whichever project you are looking at. */
  notifications?: { enabled?: boolean }
  /** The user's curated selection of default (vendor) skills — `open-mercato/skills`. GLOBAL, not
   *  per-repo: "which skills I want" describes the person, not a checkout, and must not depend on
   *  the launch directory. Tri-state: ABSENT means "not curated", so every default skill shows
   *  (opt-out default; existing installs are never silently emptied on upgrade); a PRESENT array
   *  (even `[]`) means only those names show from that repo. The gate lives server-side in
   *  `discoverSkills`; the Skills page's Manage panel writes the whole array (shallow top-level merge). */
  importedSkills?: string[]
  [key: string]: unknown
}

/** `GET/PUT /api/workspace/config` — the settings slice of `~/.cezar/config.json` (step 2.7).
 *  Global knobs only: the registry itself is `GET /api/projects`, and `schemaVersion` (a
 *  migration cursor, not a setting) is deliberately absent. `resources` is the workspace's
 *  host-protection budget — the ONLY effective `maxParallel`/`memoryLimitMb` since Phase 2
 *  (spec §"Resource governance"); `worktreeRetentionDefault` seeds projects that set none. */
export interface WorkspaceConfigResponse {
  browseRoot: string
  projectsDir: string
  skillsAutoUpdate: boolean | null
  effectiveSkillsAutoUpdate: boolean
  composerDefaults?: {
    autonomous: boolean | null
    worktree: boolean | null
    inheritedAutonomous: boolean | 'source-dependent'
    inheritedWorktree: boolean
  }
  resources: {
    maxParallel: number
    maxMonitoringSessions?: number
    monitoringWakeIntervalMinutes?: number | null
    memoryLimitMb: number | null
    worktreeRetentionDefault: number
  }
}

/** `PUT /api/workspace/config` body — partial: absent keys stay untouched. A rejected
 *  workspace root (not writable) 400s with the reason and persists NOTHING, resources
 *  included, so callers may send both in one request only if they want that atomicity. */
export interface SetWorkspaceConfigInput {
  browseRoot?: string
  projectsDir?: string
  skillsAutoUpdate?: boolean | null
  composerDefaults?: {
    autonomous?: boolean | null
    worktree?: boolean | null
  }
  resources?: {
    maxParallel?: number
    maxMonitoringSessions?: number
    monitoringWakeIntervalMinutes?: number | null
    memoryLimitMb?: number | null
    worktreeRetentionDefault?: number
  }
}

/** `GET /api/launch-key` — the bookmarklet auto-start secret (spec 011). Fetched to COMPARE
 *  against the `?key=` query param (/new deep link) and to bake into the `javascript:` links
 *  the Settings → Skills bookmarklet panel generates (the legacy generator's exact use). The
 *  value never renders as text, never logs, and never goes back into the address bar. */
export interface LaunchKeyResponse {
  key: string
}

// ---- session git view (src/server/git-changes.ts, R5) ---------------------------------------

/** One changed file of `GET /api/runs/:id/changes` / `GET /api/repo/changes`. Assignable to
 *  the diff facade's `DiffFileChange` (components/diff/types.ts) by construction. */
export interface ChangedFile {
  path: string
  /** Rename/copy source — present only when `status` is renamed/copied. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  adds: number
  dels: number
  /** Binary per numstat — there is no text patch to render. */
  binary: boolean
  /** True when the path is one the raw-bytes route serves as an `<img>` (#365) — present only
   *  when true, so old clients that never read it stay correct. */
  image?: boolean
  /** This file's unified-diff section; possibly `… (patch truncated)`, possibly empty. */
  patch: string
}

/** `GET /api/runs/:id/changes` — the structured worktree-vs-base diff. 409 (+ reason) when
 *  the run has no worktree or git itself refuses; never HTML. */
export interface ChangesPayload {
  files: ChangedFile[]
  stat: { adds: number; dels: number; files: number }
  /** Additive context for review tasks whose worktree HEAD no longer matches their own branch. */
  repointedHead?: { headBranch: string; taskBranch: string }
}

/** `GET /api/runs/:id/files?path=` — a directory listing or one file (size-capped, binary
 *  flagged). `content` is absent exactly when `binary` or `tooLarge`. */
export interface WorktreeDirEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
}

export type WorktreeEntry =
  | { type: 'dir'; path: string; entries: WorktreeDirEntry[] }
  | { type: 'file'; path: string; size: number; binary: boolean; tooLarge: boolean; content?: string }

/** `POST /api/runs/:id/git/commit` — commit -A in the run's worktree. */
export interface GitCommitResponse {
  committed: boolean
  sha: string
}

/** `POST /api/runs/:id/git/push` — push the worktree's branch, setting upstream if none. */
export interface GitPushResponse {
  pushed: boolean
  branch: string
  remote: string
  upstreamSet: boolean
}

// ---- repo view (src/server/git.ts) ---------------------------------------------------------

export interface StatusEntry {
  status: string
  path: string
}

export interface LogEntry {
  hash: string
  subject: string
  author: string
  when: string
}

export interface RepoResponse {
  info: RepoInfo | null
  status: StatusEntry[]
  log: LogEntry[]
  branches: string[]
  baseBranch: string | null
}

/** `GET /api/repo/commit/:sha?structured=1` (R5 Step 1.7) — one commit's metadata plus the
 *  same `{files, stat}` shape the /changes routes serve. 409 (+ reason) for unknown shas;
 *  a merge commit honestly answers zero files. The bare route keeps its legacy text shape. */
export interface RepoCommitPayload {
  sha: string
  subject: string
  author: string
  /** Relative time ("3 hours ago") — same `%cr` format as the /api/repo log. */
  when: string
  files: ChangedFile[]
  stat: { adds: number; dels: number; files: number }
}

/** A commit a run made on its worktree branch (`GET /api/runs/:id/commits`). */
export interface RunCommit {
  sha: string
  subject: string
  author: string
  when: string
}

export interface RunCommitsResponse {
  commits: RunCommit[]
}

/** `POST /api/repo/branch` — switch to an existing branch or create one (from `from` or HEAD)
 *  and switch. Every predictable git failure (invalid name, unknown `from`, dirty-tree
 *  checkout conflict) is a 409 whose ApiError speaks git's words. */
export interface RepoBranchResponse {
  branch: string
  created: boolean
}

// ---- workflows (src/workflows/types.ts, src/workflows/load.ts) ------------------------------

export interface WorkflowStepDef {
  id: string
  name?: string
  prompt?: string
  skill?: string
  model?: string
  runner?: Runner
  allowedTools?: string[]
  bashAllowlist?: string[]
  command?: string
  onFail?: { retry: string; max: number }
}

export interface WorkflowDef {
  name: string
  description?: string
  steps: WorkflowStepDef[]
  source: 'built-in' | 'file'
  path?: string
}

export interface WorkflowLoadIssue {
  path: string
  message: string
}

export interface WorkflowsResponse {
  workflows: WorkflowDef[]
  /** Files that failed to load. The catalog still returns — bad files are reported, not fatal. */
  issues: WorkflowLoadIssue[]
}

/** `POST /api/plan` (spec 008): the proposed chain for a task. Never a hard failure server-side —
 *  a missing CLI, a timeout or an unparseable answer degrade to the one-step quick-task plan
 *  with `fallback: true`, which the UI surfaces as a dim note. */
export interface PlanResponse {
  /** A short kebab-case workflow title the planner proposed (spec 008 follow-up / #414). The
   *  workflow builder's auto chain creator pre-fills its name field with it. Absent on the
   *  degraded fallback, and on older servers that never sent one. */
  name?: string
  steps: WorkflowStepDef[]
  rationale: string
  fallback: boolean
}

/** `POST /api/workflows`: save a chain as `.ai/cezar/workflows/<slug>.yaml`. Exactly one of
 *  `steps` / the portable `skills` shorthand — the server's schema refines on the XOR. Without
 *  `overwrite` an existing file answers 409 with `exists: true` (see ApiError) — the UI
 *  confirms, then retries with `overwrite: true`. */
export interface SaveWorkflowInput {
  name: string
  description?: string
  steps?: WorkflowStepDef[]
  skills?: string[]
  overwrite?: boolean
}

export interface SaveWorkflowResponse {
  path: string
  name: string
}

/** `POST /api/workflows/parse` (spec 012): pasted YAML → the normalized definition. The
 *  server owns YAML parsing and validation; a bad paste is a 400 whose ApiError carries the
 *  zod/YAML reason verbatim. */
export interface ParsedWorkflow {
  name: string
  description?: string
  steps: WorkflowStepDef[]
}

/** `DELETE /api/workflows/:name` — file workflows only; built-ins answer 400. */
export interface DeleteWorkflowResponse {
  ok: boolean
  path: string
}

// ---- skills (src/skills.ts) -----------------------------------------------------------------

export interface Skill {
  name: string
  description?: string
  /** Advisory hint for untouched composer run-mode choices. */
  interactive?: true
  body: string
  path: string
  source: 'ai' | 'cezar' | 'agents' | 'global' | 'team'
  /** Team skills only: where the definition lives in its skills repo. */
  team?: {
    repo: string
    ref: string
    path: string
    dir: boolean
  }
}

// ---- inbox (src/todos.ts) --------------------------------------------------------------------

export interface TodoItem {
  id: string
  ts?: string
  taskId?: string
  summary: string
  action?: string
  prUrl?: string
  suggestedSkill?: string
  suggestedArgs?: string
  suggestedPrompt?: string
  /** Explicit intent; missing infers from suggestedSkill/suggestedPrompt for old files. */
  runnable?: boolean
  /** Set by the server when a task was started from this entry — by `startTodo` below, or by
   *  the cockpit's "▶ Run": since #374 that prefills the composer instead of calling that
   *  route, and the entry's id travels along (`/new?…&todo=`, then `CreateRunInput.todoId`) so
   *  the launched run is recorded here all the same. Set → the entry leaves the inbox and stays
   *  in todos.json as the audit trail; a later launch never overwrites the first. */
  startedTaskId?: string
}

/** `DELETE /api/todos/:id` — Dismiss checks the entry off. */
export interface RemoveTodoResponse {
  removed: boolean
}

/** `POST /api/todos/:id/start` — turns the entry into a task in one step (201 with the new
 *  run). Still a documented public route (BACKWARD_COMPATIBILITY.md) for anyone scripting the
 *  cockpit directly, but (#374) the Inbox's own "▶ Run" no longer calls it — it navigates to
 *  a prefilled `/new` instead so the user can review the suggestion before starting it. */
export interface StartTodoResponse {
  run: RunRecord
}

// ---- GitHub tab (src/server/github.ts) --------------------------------------------------------

export interface GithubItem {
  kind: 'issue' | 'pr'
  number: number
  title: string
  author: string
  createdAt: string
  labels: string[]
  body: string
  url: string
  comments: number
  /** PRs only. */
  isDraft?: boolean
  additions?: number
  deletions?: number
  checks?: 'passing' | 'failing' | 'pending' | null
}

export interface GithubData {
  available: boolean
  /** Why it is unavailable (`gh` missing, no remote, offline…). Never an error — a hint. */
  reason?: string
  /** owner/name, when known. */
  repo?: string
  syncedAt?: string
  issues: GithubItem[]
  prs: GithubItem[]
  /** Repo-wide label name → 6-hex color (no `#`); lets chips tint like GitHub. Additive. */
  labelColors?: Record<string, string>
}

/** `GET /api/github/checks?prs=…` (#664) — lazy PR checks glyphs, `number → glyph`. The list call
 *  no longer ships `statusCheckRollup`, so a row's glyph is hydrated through this endpoint for the
 *  on-screen rows only. Degrades to `{ available: false, reason }`; an absent number means "no
 *  checks / not found". */
export type GithubChecksData =
  | { available: true; checks: Record<number, 'passing' | 'failing' | 'pending' | null> }
  | { available: false; reason: string }

export type GithubMergeMethod = 'merge' | 'squash' | 'rebase'

export interface GithubPrMergeState {
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  headRef: string
  baseRef: string
  headSha: string
  mergeable: 'mergeable' | 'conflicting' | 'unknown'
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'unknown'
  checks: Array<{
    name: string
    state: 'passing' | 'failing' | 'pending' | 'unknown'
    required: boolean | null
    url?: string
  }>
  methods: GithubMergeMethod[]
  defaultMethod: GithubMergeMethod | null
  eligibility: 'ready' | 'blocked' | 'pending' | 'unauthorized' | 'terminal' | 'unknown'
  blockers: Array<{ code: string; message: string }>
  canMerge: boolean
}

export type GithubPrMergeStateResponse =
  | { available: true; mergeState: GithubPrMergeState }
  | { available: false; reason: string }

export interface GithubMergeResponse {
  merged: true
  number: number
  url: string
  method: GithubMergeMethod
  mergeCommitSha?: string
}

/** One comment or PR review summary in an issue/PR thread (`GET /api/github/comments/…`, #499). */
export interface GithubComment {
  id: number
  author: string
  avatarUrl?: string
  createdAt: string
  body: string
  kind: 'comment' | 'review'
  reviewState?: 'approved' | 'changes_requested' | 'commented' | 'dismissed'
  url: string
}

/** The timeline event kinds the thread renders (#525) — an allowlist, so an unknown GitHub event
 *  type is dropped server-side rather than reaching the client. Mirrors
 *  `ForgeTimelineEventKind`. */
export type GithubTimelineEventKind =
  | 'committed'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'head_ref_force_pushed'
  | 'cross-referenced'
  | 'renamed'

/** One non-comment timeline row (#525) — commit, label change, assignment, merge, force-push,
 *  cross-reference or rename. Mirrors `ForgeTimelineEvent`. Deliberately a separate type from
 *  `GithubComment` rather than a widened `kind`, which would break narrowing below. */
export interface GithubTimelineEvent {
  id: string
  kind: GithubTimelineEventKind
  /** Login — or the git author name for `committed`, which carries no GitHub actor. */
  actor: string
  /** Absent for `committed`. */
  avatarUrl?: string
  createdAt: string
  url?: string
  /** `committed` — full 40-char SHA. */
  sha?: string
  /** `committed` — first line, capped at 120 chars. */
  message?: string
  /** `committed` — **absent** (lookup failed/skipped) and **`null`** (no CI configured) both
   *  render no glyph, but stay distinct values. */
  checks?: 'passing' | 'failing' | 'pending' | null
  label?: { name: string; color?: string }
  /** `assigned`/`unassigned` login, or the new title for `renamed`. */
  subject?: string
  refNumber?: number
  refTitle?: string
  refIsPr?: boolean
}

/** `GET /api/github/comments/:kind/:number` — degrades to `{ available: false, reason }` like the
 *  list fetch, never an error. */
export interface GithubCommentsData {
  available: boolean
  reason?: string
  comments: GithubComment[]
  /** True when either stream hit its cap, or the timeline fetch stopped short. */
  truncated?: boolean
  /** Timeline events (#525) — additive and optional; absent when the server degraded to the
   *  legacy comments-only fetch. Capped independently of `comments`. */
  events?: GithubTimelineEvent[]
}

export interface GithubPrChange {
  path: string
  previousPath?: string
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed'
  additions: number
  deletions: number
  patch?: string
  patchUnavailableReason?: 'binary' | 'too-large' | 'not-provided'
  truncated?: boolean
}

export type GithubPrChangesData =
  | { available: true; number: number; headSha: string; files: GithubPrChange[]; additions: number; deletions: number; truncated: boolean; reason?: string }
  | { available: false; reason: string }

// ---- GUI prefs (`PUT /api/ui-state`) -----------------------------------------------------------

/** The keys the server's schema names. It is a passthrough schema, so unknown keys round-trip
 *  untouched — future prefs need no server change, which is why this stays open. */
export interface UiState {
  lastTask?: { source: 'workflow' | 'skill'; ref: string }
  /** Most-recently-run sources, newest first (deduped, capped). Feeds the composer picker's
   *  recency sort so the skills you actually use float to the top of their locality group. */
  recentSources?: { source: 'workflow' | 'skill'; ref: string }[]
  /** The last worktree choice for a single-skill run — remembered so the checkbox re-opens where
   *  you left it. Absent → the default (isolated worktree). */
  lastWorktree?: boolean
  /** The last autonomous choice — remembered like lastWorktree. Absent → off. */
  lastAutonomous?: boolean
  /** Whether new runs should ask agents to append follow-up work. Absent → on. */
  lastGenerateFollowups?: boolean
  /** Skill selection frequency (#408): name → times chosen, across BOTH composers (`/new` and
   *  the GitHub tab's follow-up picker). Feeds `orderSkillsByUsage` (lib/skills.ts) — the
   *  most-selected skills float to the top of their project/global locality group. */
  skillUsage?: Record<string, number>
  runsView?: 'list' | 'table'
  /** The GitHub tab's last-selected sub-tab (#417) — issues or PRs. Absent → issues. */
  githubView?: 'issues' | 'prs'
  /** Settings → Appearance (redesign R6): accent + density. Theme itself stays in
   *  localStorage (`cez-theme`) — it must pre-paint, and it is per-browser by design. */
  appearance?: { accent?: 'lime' | 'violet'; density?: 'comfortable' | 'compact' | 'ultra' }
  /** Settings → Notifications (redesign R6 1.7): the browser-notification toggle. Off unless
   *  literally `true`. Permission itself is per-browser and never persisted. */
  notifications?: { enabled?: boolean }
  /** Follow-up prompt templates (#413): reusable snippets insertable into the GitHub hand-over,
   *  Inbox, and /new composers. Absent → the built-in defaults (`lib/prompt-templates.ts`);
   *  present (even `[]`) is the user's own edited list from Settings → Prompt templates.
   *  `skills` (optional) are the skill names the template auto-applies for. */
  promptTemplates?: { id: string; label: string; text: string; skills?: string[] }[]
  /** The open-mercato/skills promo banner (#391), dismissed for good. Legacy — the banner is
   *  gone, replaced by the workspace-level `importedSkills` curation (see `WorkspaceUiState`);
   *  retained so old ui-state.json round-trips. */
  dismissedSkillsBanner?: boolean
  [key: string]: unknown
}

/** One row in the "Manage skills" panel — a skill a default (vendor) repo offers,
 *  from `GET /api/skills/importable`, independent of whether it is currently kept. */
export interface ImportableSkill {
  name: string
  description?: string
}

// ---- request bodies ------------------------------------------------------------------------------

/** An inline image, base64 — the same shape `POST /api/runs` and the message endpoint take
 *  (≤4 images, ~5 MB each once decoded). */
export interface ImageInput {
  mediaType: string
  data: string
}

/** `POST /api/runs`. Exactly one of `workflow` / `steps` — the server rejects both or neither. */
export interface CreateRunInput {
  task: string
  workflow?: string
  steps?: WorkflowStepDef[]
  model?: string
  runner?: Runner
  /** 1–3. Above 1 the response is `{ runs }` rather than a single record. */
  variants?: number
  images?: ImageInput[]
  /** false → run in the repo working tree instead of an isolated worktree (read-only skills).
   *  Omit for the default. Ignored server-side when variants > 1. */
  worktree?: boolean
  /** true → autonomous run: never parks at "waiting" for the user; auto-continues until done. */
  autonomous?: boolean
  /** false → keep the handoff journal but do not expose or request a follow-up todos file.
   *  Omit for the default (enabled). */
  generateFollowups?: boolean
  /** The inbox entry this task came from (#374), when the composer was prefilled from one
   *  (`/new?…&todo=`). The server records the new run on that entry's `startedTaskId` so it
   *  leaves the inbox. Best-effort: an unknown or already-started id never fails the run.
   *  For ×2/×3 the FIRST variant is recorded — the thread the composer navigates to.
   *  Orthogonal to `generateFollowups` (#444): that governs whether THIS task may append new
   *  follow-ups, not whether the entry it was launched from gets marked started. */
  todoId?: string
}

export interface MessageInput {
  text?: string
  images?: ImageInput[]
}

/** `PATCH /api/runs/:id` (#389). `title`: trimmed server-side, 1–300 chars. The edit sets both
 *  `title` and `titleSummary`, so it wins over any auto-summary. Answers the updated record.
 *  `task` (#472): the initial prompt, editable only while the run is still queued — any other
 *  status answers `409 run already started`. 1–100 000 chars, and bounded again by the folded
 *  total across the task and its stack. */
export interface PatchRunInput {
  title?: string
  task?: string
}

/** Per-runner default model preset (Settings → Agents, R6 1.5): the composer preselects this
 *  model id for the runner. Absent = auto (the runner decides). */
export type RunnerModels = Partial<Record<Runner, string>>

/** `GET /api/config` (additive R6 route): every Settings → Agents knob in one read. */
export interface ConfigResponse {
  baseBranch: string | null
  defaultRunner: Runner
  systemPrompt: string | null
  defaultModels: RunnerModels
  /** How many tasks run at once (1–16). */
  maxParallel: number
  /** Per-task memory ceiling in MiB (whole process tree); null = no limit. */
  memoryLimitMb: number | null
  /** Keep the last N finished worktrees on disk (#483); 0 = unlimited. Older
   *  ones are reclaimed (directory only — branch kept, so work is recoverable). */
  worktreeRetention: number
  /** Live title updates (task auto-naming): null = no config key, the
   *  CEZ_TITLE_UPDATES env default (ON) decides. */
  liveTitleUpdates: boolean | null
  /** Optional review gate (#489): null = no config key, the CEZ_REVIEW_GATE env
   *  default (OFF) decides. */
  reviewGate: boolean | null
}

/** `PUT /api/config` (Settings → Agents; the Repo tab's base-branch picker). `baseBranch: null`
 *  clears the setting back to "follow checked-out branch"; `systemPrompt` and per-runner `defaultModels`
 *  entries clear on `null` (or `''`) too. Merged into the raw config.json server-side —
 *  `defaultModels` merges per runner, so one write never clobbers another runner's preset. */
export interface SetConfigInput {
  baseBranch?: string | null
  defaultRunner?: Runner
  systemPrompt?: string | null
  defaultModels?: Partial<Record<Runner, string | null>>
  maxParallel?: number
  /** null or 0 clears the ceiling back to "no limit". */
  memoryLimitMb?: number | null
  /** Keep last N finished worktrees (#483); 0 = unlimited, null clears back to
   *  the default (10). */
  worktreeRetention?: number | null
  /** null clears the key back to the env-default behavior. */
  liveTitleUpdates?: boolean | null
  /** null clears the key back to the env-default behavior (OFF). */
  reviewGate?: boolean | null
}

/** The PUT answer: the same shape GET serves (the pre-R6 fields stayed, the rest is additive). */
export type SetConfigResponse = ConfigResponse

// ---- Agent config files (spec #404) --------------------------------------------------------

export type AgentConfigFormat = 'json' | 'jsonc' | 'toml' | 'markdown'
export type AgentConfigScope = 'user' | 'project' | 'local'
export type AgentConfigKind = 'settings' | 'memory' | 'mcp'
export type AgentConfigTracked = 'tracked' | 'gitignored' | 'outside-repo'

export interface AgentConfigFile {
  id: string
  runners: Runner[]
  kind: AgentConfigKind
  scope: AgentConfigScope
  label: string
  path: string
  format: AgentConfigFormat
  tracked: AgentConfigTracked
  seeded: boolean
  holdsMcp: boolean
  precedence: string
  hotReload?: string
  docsUrl: string
  exists: boolean
  size: number
  version: string | null
  writable: boolean
  readOnlyReason?: string
}

export interface UserMcpListing {
  path: string
  servers: string[]
  readable: boolean
}

export interface AgentConfigListing {
  editable: boolean
  files: AgentConfigFile[]
  userMcp: UserMcpListing | null
}

export interface AgentConfigFileContent {
  id: string
  path: string
  exists: boolean
  content: string
  version: string | null
}

export interface SetAgentConfigInput {
  content: string
  version: string | null
}

/** One materialized task worktree in the management panel (#483). `sizeBytes` is
 *  null when `du` is unavailable (Windows / missing). `reclaimable` = finished,
 *  has a directory, not yet reclaimed (retention's rule). */
export interface WorktreeInfo {
  runId: string
  title: string
  status: string
  branch: string | null
  sizeBytes: number | null
  finishedAt: string | null
  reclaimable: boolean
}

/** `GET /api/worktrees` (#483): the worktrees on disk, their total size (null when any
 *  degraded), and the current keep-limit (0 = unlimited). */
export interface WorktreesResponse {
  worktrees: WorktreeInfo[]
  totalBytes: number | null
  keep: number
}

/** `POST /api/worktrees/reclaim` (#483): the run ids whose directory was reclaimed. */
export interface ReclaimWorktreesResponse {
  reclaimed: string[]
}

/** `POST /api/runs/:id/remove-worktree`: per-row delete in the worktrees panel. */
export interface RemoveWorktreeResponse {
  removed: boolean
}

/** A local app a worktree can be opened in (#open-in): editor, file manager, or terminal. */
export interface OpenTarget {
  id: string
  label: string
  /** A stable icon key (#361) the UI maps to a concrete icon — `openInIcon` in run-header.tsx.
   *  Optional: an older server omitting it just renders the generic fallback icon. */
  icon?: string
}

/** `GET /api/open-targets` — the detected local apps; empty in hosted mode (CEZ_REMOTE). */
export interface OpenTargetsResponse {
  targets: OpenTarget[]
}

export type SkillsUpdateStatus = 'idle' | 'checking' | 'available' | 'updating' | 'current' | 'unavailable' | 'error'
export interface SkillsUpdateScopeState {
  scope: 'project' | 'global'
  status: SkillsUpdateStatus
  available: boolean
  skills: string[]
  checkedAt: string | null
  updatedAt: string | null
  reason?: string
}
export interface SkillsUpdateState {
  status: SkillsUpdateStatus
  available: boolean
  autoUpdateEnabled: boolean
  inherited: boolean
  checkedAt: string | null
  updatedAt: string | null
  scopes: SkillsUpdateScopeState[]
  needsUpgradeNotes: boolean
}

// ---- mutation responses ---------------------------------------------------------------------------

/** `POST /api/runs` — one record for ×1, a group for ×2/×3. */
export type CreateRunResponse = ApiRun | { runs: RunRecord[] }

export interface CancelResponse {
  cancelled: boolean
}

/** `POST /api/runs/archive-finished` — how many runs the sweep archived. */
export interface ArchiveFinishedResponse {
  archived: number
}

export interface DeleteRunResponse {
  deleted: boolean
}

export interface FinishResponse {
  finished: boolean
}

export interface ContinueResponse {
  continued: boolean
}

/** `POST /api/runs/:id/pr` (spec 009) — the draft PR's URL; `dryRun` marks the CEZ_DRY_RUN
 *  fake (no push, no gh). On failure the server answers 409 and the `ApiError` carries the
 *  `manual` merge command instead. */
export interface CreatePrResponse {
  url: string
  dryRun?: boolean
}

/** `POST /api/runs/:id/messages` answers one of three shapes (#472), by how far the run has got:
 *  `delivered` — a live session took it; `queued` — still waiting for a slot, so it was stacked
 *  onto the prompt (the stored entry rides along); `deferred` — the run is mid-spawn, so it was
 *  buffered and will arrive as an ordinary follow-up turn the moment the session opens. Anything
 *  else is still a `409`. Pre-#472 clients only ever saw `delivered` and keep working. */
export interface MessageResponse {
  delivered?: boolean
  queued?: boolean
  deferred?: boolean
  message?: QueuedMessage
}

/** One prompt message stacked onto a queued run (#472). */
export interface QueuedMessage {
  id: string
  text: string
  /** `/api/runs/:id/images/…` URLs — attachments are persisted, never inlined. */
  images?: string[]
  createdAt: string
}

/** `PATCH /api/runs/:id/queued-messages/:msgId` (#472) — replaces the entry's text and images.
 *  `404` unknown run or message id; `409 run already started`. */
export interface EditQueuedMessageResponse {
  message: QueuedMessage
}

/** `DELETE /api/runs/:id/queued-messages/:msgId` (#472). */
export interface RemoveQueuedMessageResponse {
  removed: boolean
}

/** `POST /api/runs/:id/open-in-cli` — a terminal was spawned with `command` running in it.
 *  When no terminal emulator exists the server answers 409 instead, and the `ApiError` carries
 *  the full `cd … && <command>` in its `command` field for the clipboard fallback. */
export interface OpenInCliResponse {
  opened: boolean
  command: string
}
