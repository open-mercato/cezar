import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../automations/store.ts';
import { AutomationCoordinator } from '../automations/coordinator.ts';
import { GithubPoller } from '../automations/github-poller.ts';
import { ProjectAutomationScheduler, WorkspaceAutomationScheduler } from '../automations/scheduler.ts';
import { launchAutomationRun, reconcileAutomationReceipts, validateAutomationPrompt } from '../automations/task-template.ts';
import {
  automationEventSchema,
  automationFiltersSchema,
  automationLogResultSchema,
  automationTaskSchema,
  type AutomationDefinition,
} from '../automations/types.ts';
import type { IncomingMessage } from 'node:http';
import { access, constants as fsConstants, mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import type { Next } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type {
  GroupResponse,
  GroupVariant,
  PickVariantResponse,
} from '@open-mercato/cezar-contract';
import { detectEnvironment } from '../core/backend-detect.ts';
import type { ContentBlock } from '../core/agent-runner.ts';
import { discoverCodexModels } from '../core/codex-model-catalog.ts';
import {
  PROVIDER_IDS,
  ProviderAuthService,
  type ProviderId,
  type ProviderStatusResponse,
} from '../core/provider-auth.ts';
import { applyProviderEnablement } from '../core/provider-availability.ts';
import { RunnerModelCatalog } from '../core/runner-model-catalog.ts';
import { currentUsage, onUsage } from '../core/process-usage.ts';
import { WORKFLOWS_DIR, loadWorkflows } from '../workflows/load.ts';
import {
  QUICK_TASK_WORKFLOW,
  normalizeWorkflowDoc,
  skillStackOf,
  skillsToSteps,
  stepsIssue,
  workflowFileSchema,
  workflowStepSchema,
  type WorkflowDef,
} from '../workflows/types.ts';
import { planChain, slugify } from '../planner.ts';
import { discoverSkills } from '../skills.ts';
import { SkillsUpdateConflictError, SkillsUpdateCoordinator, SkillsUpdateService, type SkillsUpdateState } from '../skills-update.ts';
import { getTeamSkillsCached, refreshTeamSkills, waitForTeamSkills } from '../skills-remote.ts';
import { appendHandoffHeartbeat, handoffProgressExcerpt, readHandoff } from '../handoff.ts';
import { markStarted, onTodosChanged, readTodos, removeTodo, todoTaskText, type TodoItem } from '../todos.ts';
import type { RunEvent, RunRecord, RunStatus, RunStore } from '../runs/store.ts';
import { isV2WireEventType } from '../runs/ui-event-sink.ts';
import type { RunManager } from '../workflows/run.ts';
import { removeWorktree, worktreeDiff, worktreeDiffStat, worktreeSizeBytes } from '../git-worktree.ts';
import { isReclaimable, reclaimWorktrees } from '../runs/retention.ts';
import { getBranches, getCommit, getDiff, getLog, getRepoInfo, getStatus } from './git.ts';
import {
  collectChanges,
  collectCommitChanges,
  collectRunCommits,
  commitAll,
  createOrSwitchBranch,
  imageMimeType,
  isOsOpenableImage,
  pushCurrentBranch,
  readWorktreePath,
} from './git-changes.ts';
import { gatedSkillsRepos, loadConfig, resolveWorktreeRetention, type CezConfig } from '../config.ts';
import { findConfigFile } from '../agent-config/catalog.ts';
import { readConfigFile, writeConfigFile } from '../agent-config/files.ts';
import { listAgentConfig } from '../agent-config/service.ts';
import {
  PROJECT_ID_RE,
  defaultWorkspaceConfig,
  effectiveSkillsAutoUpdate,
  loadWorkspaceConfig,
  mergeWriteWorkspaceConfig,
  effectiveComposerDefault,
  type WorkspaceConfig,
  type WorkspaceProject,
} from '../workspace/config.ts';
import {
  allocateProjectSlug,
  listProjects,
  probeProjectStatus,
  registerProject,
  removeProject,
  shouldRegisterProject,
  type ProjectListEntry,
} from '../workspace/projects.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { mergeWriteWorkspaceUiState, readWorkspaceUiState } from '../workspace/ui-state.ts';
import { checkoutRepo, type CloneRunner } from './checkout.ts';
import { ProjectContextError, ProjectContexts, type ProjectContext } from './project-context.ts';
import { reviewGateEnabled } from '../runs/review-gate.ts';
import { readUiState, uiStatePath } from '../ui-state.ts';
import { expandTilde } from '../paths.ts';
import { isLoopbackHostHeader, normalizeHostname, resolveCapabilities } from './capabilities.ts';
import { createSocketHub, type SocketHub, type WsUpgradeVerdict } from './ws.ts';
import { browseDirectory, isInsideBrowseRoot, isLexicallyInsideBrowseRoot, resolveBrowseRoot } from './fs-browse.ts';
import { parseRemote, resolveForge, type ForgeAvailability } from './forge/index.ts';
import { fetchGithub, fetchGithubChecks, fetchGithubComments, fetchGithubPrDiff, GithubPrNotFoundError, GH_CHECKS_MAX } from './github.ts';
import { ensureLaunchKey } from './launch-key.ts';
import { openInTerminal } from './open-in-terminal.ts';
import { agentCliRunner, detectOpenTargets, openFileInDefaultApp, openInApp } from './open-in-app.ts';
import { createDraftPr } from './pr.ts';
import { ProviderRuntimeAuthObserver } from './provider-auth-runtime.ts';
import {
  providerForActiveRun,
  providerForExistingRun,
  providersRequiredByWorkflow,
  unavailableProviderMessage,
} from './provider-action-gate.ts';
import {
  ASSET_CACHE_CONTROL,
  BUILD_HINT_HTML,
  assetContentType,
  isSafeAssetFilename,
  resolveGetRequest,
} from './static-ui.ts';

export interface ServerDeps {
  repoRoot: string;
  store: RunStore;
  manager: RunManager;
  version: string;
  /** Mutable holder for the async npm-registry update check (#368) —
   *  `latest` appears once the registry answers with a newer version. */
  update?: { latest?: string };
  /** Host the HTTP server binds (default 127.0.0.1). A non-loopback host
   *  implies hosted mode — `capabilities.localHandoff:false`. */
  bindHost?: string;
  /** Workspace-registry id of the boot project (multi-project spec) — plumbed
   *  from `initWorkspace` in src/index.ts. Optional: legacy callers/tests get
   *  a lazy registry lookup by `repoRoot`, falling back to the repo's slug. */
  bootProjectId?: string;
  /** Per-project context map (multi-project spec, step 2.2). Non-boot
   *  `/api/p/:projectId/*` requests resolve their `{store, manager, …}` here,
   *  built lazily on first touch. Optional so legacy callers change nothing —
   *  the default is a registry-backed map; tests inject their own so they can
   *  `disposeAll()` after. The BOOT project never lives in this map: its
   *  context is seeded from `deps.{store,manager}` (which src/index.ts already
   *  recovered/pruned at startup) and the resolver short-circuits to it. */
  contexts?: ProjectContexts;
  /** Boot project's shared automation store. `startServer` injects the
   *  coordinator-owned instance so HTTP routes and the scheduler never cache
   *  separate views of the same project files. */
  automationStore?: AutomationStore;
  /** Workspace-wide parallel-cap semaphore + cached resource config (spec
   *  2026-07-20, step 2.5): the ONE instance boot created, refreshed, and gave
   *  the boot manager — threaded into the default `ProjectContexts` so every
   *  project's RunManager shares it. Step 2.7's `PUT /api/workspace/config`
   *  calls `semaphore.refresh()` after a write. Optional so legacy
   *  callers/tests change nothing. */
  semaphore?: WorkspaceSemaphore;
  /** Workspace-level SSE bus (spec, step 2.8): `project-added` /
   *  `project-removed` / `checkout-progress` plus the host-wide unstamped
   *  `provider-status` event reach `/api/workspace/events` through this.
   *  Optional — createApp builds a private one; inject to emit from outside
   *  the app (tests, future CLI hooks). */
  workspaceEvents?: WorkspaceEventBus;
  /** How `POST /api/projects/checkout` (step 4.3) actually clones. Defaults to
   *  `gh repo clone` (or the `CEZ_DRY_RUN=1` fake) — injected by tests so the
   *  route's guards, cleanup and error surfacing are exercised for real
   *  against real temp dirs, without a network or a `gh` binary. */
  cloneRunner?: CloneRunner;
  /** Host-wide model discovery service. Tests inject a deterministic adapter. */
  modelCatalog?: RunnerModelCatalog;
  /** Host-wide provider authentication discovery. Tests inject deterministic probes. */
  providerAuth?: ProviderAuthService;
  /** Global provider enablement preferences. Tests may inject an in-memory store. */
  workspaceConfig?: {
    load: typeof loadWorkspaceConfig;
    mergeWrite: typeof mergeWriteWorkspaceConfig;
  };
  /** Shared runtime rejection observer. The CLI injects the instance already
   *  watching the boot store before recovery; createApp builds one for legacy
   *  callers and tests. */
  providerRuntimeAuth?: ProviderRuntimeAuthObserver;
  /** Local terminal handoff for provider-owned login. */
  openTerminal?: typeof openInTerminal;
  /** Process-wide Open Mercato skills update detector. Injected in tests and
   * shared by every workspace route/project; createApp owns the default. */
  skillsUpdate?: SkillsUpdateService;
  /** WebSocket subscription hub (`/api/v1/ws`, src/server/ws.ts). `createApp`
   *  only registers topics on it — `startServer` builds one and attaches it
   *  to the HTTP server it binds. Optional so legacy callers/tests change
   *  nothing: no hub, no topics, and the HTTP surface is byte-identical. */
  socketHub?: SocketHub;
  /** Re-arm the workspace automation timer after definition mutations. */
  automationsChanged?: () => void;
}

// ---- project-scoped routing (multi-project spec, step 2.2) -----------------

/** Hono env for the mirrored project-route table: the scope resolver puts the
 *  request's `ProjectContext` on the context, handlers read `c.get('project')`. */
type ProjectApiEnv = { Variables: { project: ProjectContext } };

/** `projectId` gate at the route boundary (spec "Project identity"): the slug
 *  shape or the reserved `default` alias — validated BEFORE touching any map
 *  or path. (`default` matches the slug regex too; the literal keeps the
 *  contract explicit.) */
const projectIdSchema = z.union([z.literal('default'), z.string().regex(PROJECT_ID_RE)]);

const providerConnectSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
}).strict();

const providerParamSchema = z.enum(PROVIDER_IDS);
const providerEnabledSchema = z.object({ enabled: z.boolean() }).strict();
const providerRetrySchema = z.object({
  authFailureId: z.string().min(1).max(128),
}).strict();

const automationEditableSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    enabled: z.boolean().optional(),
    events: z.array(automationEventSchema).min(1).max(4),
    intervalSeconds: z.number().int().min(60).max(86_400),
    filters: automationFiltersSchema,
    task: automationTaskSchema,
  })
  .strict();
const automationCreateSchema = automationEditableSchema.extend({ enable: z.boolean().optional() });
const automationUpdateSchema = automationEditableSchema.extend({ expectedRevision: z.number().int().positive() });
const automationCheckRequestSchema = z.object({ mode: z.enum(['preview', 'execute']) }).strict();
const automationLogQuerySchema = z.object({
  automationId: z.string().optional(),
  result: automationLogResultSchema.optional(),
  event: automationEventSchema.optional(),
  since: z.string().datetime().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  // Optional, not `.default(100)`: `AutomationStore.logs` already clamps `limit ?? 100` into
  // 1..100, so the default here was a second copy of it — and a defaulted key is REQUIRED in the
  // request type `queryZodValidator` publishes (see validators.ts on why the request side falls
  // back to the schema's output), which would have made every caller send a `?limit=` this route
  // never needed.
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function editableAutomation(definition: AutomationDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    enabled: definition.enabled,
    events: definition.events,
    intervalSeconds: definition.intervalSeconds,
    filters: definition.filters,
    task: definition.task,
  };
}

/** One row of the mirrored project-route table. */
export interface ProjectRouteInfo {
  method: string;
  /** Path relative to the mount — `/runs/:id`, not `/api/runs/:id`. */
  path: string;
}

/**
 * The public API surface (spec 2026-07-23-independent-server-web-packages).
 *
 * Every route lives under this one prefix. The unversioned `/api/*` spelling the cockpit used
 * to speak was removed once the whole API was reachable here — carrying two spellings meant two
 * surfaces to keep working, and only one of them could be the typed contract. Bumping to `v2`
 * means mounting a second table beside this one, not editing route paths.
 */
const V1_PREFIX = '/api/v1';

/** Project scoping inside the versioned surface. The version is the OUTER dimension, so a
 *  consumer picks its API version once and then addresses projects inside it. */
const V1_SCOPED_PREFIX = `${V1_PREFIX}/p/:projectId`;

/**
 * The project-scoped route table of a `createApp()` app, derived from its actual registrations
 * (so it can never drift from the code): every method+path mounted under
 * `/api/v1/p/:projectId/…`, minus the scope-resolver middleware (method ALL), deduped. The
 * alias-parity suite iterates this to assert `/api/v1/<path>` ≡ `/api/v1/p/<boot>/<path>` ≡
 * `/api/v1/p/default/<path>`.
 */
export function projectRouteManifest(app: Hono): ProjectRouteInfo[] {
  const seen = new Set<string>();
  const manifest: ProjectRouteInfo[] = [];
  for (const route of app.routes) {
    if (route.method === 'ALL' || !route.path.startsWith(`${V1_SCOPED_PREFIX}/`)) continue;
    const path = route.path.slice(V1_SCOPED_PREFIX.length);
    const key = `${route.method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    manifest.push({ method: route.method, path });
  }
  return manifest;
}

/** 409 body for the inbox mutators while the follow-up inbox is off (#471). */
const FOLLOWUPS_OFF = 'the follow-up inbox is disabled — set CEZ_FOLLOWUPS=1 to enable it';

// ---- variant-compare response shapes (spec 010) ----------------------------
// Named and exported so `api-types.test.ts` can drift-guard the cockpit's
// hand-mirrored copies (`web/app/src/api/types.ts`) against the real thing.

/** One column of `GET /api/groups/:groupId`. NOTE: `diffStat` here is the raw
 *  `git diff --stat` text (worktreeDiffStat), NOT the numeric `RunRecord.diffStat`. */
/** `GET /api/projects` (multi-project spec) — the workspace registry with
 *  per-root status probes. Absolute `root`s belong HERE (same-origin, behind
 *  the cockpit) and are deliberately never mirrored into the CORS-open
 *  `/api/health` payload (#431 — see the health route). Never 404s. */
export interface ProjectsResponse {
  projects: ProjectListEntry[];
  bootProject: string;
  projectsDir: string;
}

/** `POST /api/projects` (multi-project spec, step 4.2) — the folder-browser
 *  dialog's commit step. The entry carries the same `status`/`branch` probe
 *  `GET /api/projects` attaches, so the cockpit sees one project shape.
 *  `error` is present ONLY on the 409 (already registered), where `project` is
 *  the EXISTING entry — the dialog navigates to it instead of dead-ending. */
export interface RegisterProjectResponse {
  project: ProjectListEntry;
  error?: string;
}

/** `DELETE /api/projects/:projectId` (multi-project spec, step 4.4) — the
 *  Projects settings pane's Remove. DEREGISTRATION ONLY: the entry leaves
 *  `~/.cezar/config.json` and nothing under the project root is read, moved or
 *  deleted. `removed` is always true on a 200 (the failure paths are 404/409). */
export interface RemoveProjectResponse {
  removed: true;
  id: string;
}

/** `PATCH /api/projects/:projectId` (spec 2026-07-22-per-project-concurrency)
 *  — sets or clears a project's per-project `maxParallel`. The entry carries
 *  the same `status`/`branch` probe `GET /api/projects` attaches, so the
 *  cockpit sees one project shape. `null` in the request clears the override
 *  back to "inherit the workspace cap". */
export interface UpdateProjectResponse {
  project: ProjectListEntry;
}

/** `GET/PUT /api/workspace/config` (multi-project spec, step 2.7) — the
 *  settings slice of `~/.cezar/config.json`: global knobs ONLY, never the
 *  project registry (that is `GET /api/projects`' job). */
export interface WorkspaceConfigResponse {
  /** Root exposed by the Add project directory browser (`~` kept). */
  browseRoot: string;
  /** Checkout root for GUI-cloned projects — stored as written (`~` kept). */
  projectsDir: string;
  /** Stored override; null means inherit CEZ_SKILLS_AUTO_UPDATE, then true. */
  skillsAutoUpdate: boolean | null;
  effectiveSkillsAutoUpdate: boolean;
  composerDefaults: {
    autonomous: boolean | null;
    worktree: boolean | null;
    inheritedAutonomous: boolean | 'source-dependent';
    inheritedWorktree: boolean;
  };
  resources: {
    maxParallel: number;
    maxMonitoringSessions: number;
    monitoringWakeIntervalMinutes: number | null;
    memoryLimitMb: number | null;
    worktreeRetentionDefault: number;
  };
}

// ---- workspace SSE (multi-project spec, step 2.8) --------------------------

/** Workspace-level event names carried ONLY on `GET /api/workspace/events`
 *  (never on the per-project streams): registry mutations, the GUI-clone
 *  progress feed (step 4.3), and host-wide unstamped provider status. */
export type WorkspaceEventName =
  | 'project-added'
  | 'project-removed'
  | 'checkout-progress'
  | 'provider-status'
  | 'automation-change';

/**
 * The in-process bus for workspace-level SSE events. The registry-mutating
 * routes (`POST /api/projects` — step 4.2, emits `project-added` for a
 * genuinely new entry; `DELETE /api/projects/:projectId` — step 4.4) and the
 * checkout flow (step 4.3) call `emit()`; runtime provider auth observation
 * emits host-wide `provider-status`; every open `/api/workspace/events` stream
 * relays the event verbatim under its name. Injectable via
 * `ServerDeps.workspaceEvents` so tests (and any out-of-createApp emitter) can
 * drive the stream.
 */
export class WorkspaceEventBus {
  private readonly listeners = new Set<(event: WorkspaceEventName, data: unknown) => void>();

  emit(event: WorkspaceEventName, data: unknown): void {
    for (const listener of [...this.listeners]) listener(event, data);
  }

  /** Subscribe; returns an unsubscribe. */
  on(listener: (event: WorkspaceEventName, data: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** streamSSE with the anti-buffering contract (#424): hono's own header is a
 *  bare `no-cache`, which lets an intermediary (reverse proxy, compression
 *  middleware, corporate MITM) transform-buffer the stream — the client then
 *  sees a silently frozen transcript while the server keeps writing. Headers
 *  are set on the returned Response because hono's helper overwrites
 *  `Cache-Control` set via `c.header()` before it. */
const streamSSENoBuffer: typeof streamSSE = (c, cb, onError) => {
  const res = streamSSE(c, cb, onError);
  res.headers.set('Cache-Control', 'no-cache, no-transform');
  res.headers.set('X-Accel-Buffering', 'no');
  return res;
};

// A run starts from a named workflow OR an inline chain of steps (spec 008 —
// the approved plan is posted as-is, never written to a file).
const startRunSchema = z
  .object({
    workflow: z.string().min(1).optional(),
    steps: z.array(workflowStepSchema).min(1).max(8).optional(),
    // The primary agent prompt handed to the spawned runner. Bounded like the
    // other prompt fields (`systemPrompt` 20k, message `text` 100k) so an
    // unbounded body can't be piped into a spawned process (#429). 100k chars
    // (~25k tokens) is well past any hand-written task.
    task: z.string().min(1).max(100_000, 'must be at most 100000 characters'),
    model: z.string().optional(),
    // Agent backend for this task (falls back to config `defaultRunner`).
    runner: z.enum(['claude', 'codex', 'opencode']).optional(),
    // Parallel variants (spec 010): ×2/×3 runs the task as 2–3 competing
    // agents in separate worktrees; the user compares diffs and picks one.
    variants: z.number().int().min(1).max(3).optional(),
    // Composer worktree opt-out (#worktree-toggle): false runs in the repo
    // working tree. Ignored when variants > 1.
    worktree: z.boolean().optional(),
    // Autonomous mode (#autonomous): the run never parks at `waiting` — it
    // auto-continues until the agent signals done. No "needs you" is raised.
    autonomous: z.boolean().optional(),
    // Generate follow-up inbox entries (spec 007, #444). Honoured only while
    // the `followups` capability is on (#471) — off, the server pins it to
    // false whatever the client asked for. Omitted still means "enabled" for
    // old clients, but only within an already-enabled server. The handoff
    // journal is unaffected either way.
    generateFollowups: z.boolean().optional(),
    // Per-run system-prompt override (R2 2.3) — programmatic callers only
    // (bookmarklets, scripts); deliberately NOT a composer-UI control. Wins
    // over the config.json default; whitespace-only degrades to absent.
    systemPrompt: z
      .string()
      .trim()
      .max(20_000, 'must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
    // Screenshots pasted into the new-task form — same shape and limits as a
    // live-session message; delivered with the first agent step's opening.
    images: z
      .array(
        z.object({
          mediaType: z.string().regex(/^image\//),
          // ~5 MB per image once base64-decoded.
          data: z.string().min(1).max(7_000_000),
        }),
      )
      .max(4)
      .optional(),
    // Inbox follow-up (#374): the todo the composer was prefilled from
    // (`/new?skill=&ref=&todo=t1`). On a successful start the entry is marked
    // started — the same bookkeeping POST /api/todos/:id/start does, so the
    // audit trail survives the composer detour. Bounded like every other
    // string here; a todo id is a short generated key.
    todoId: z.string().min(1).max(200, 'must be at most 200 characters').optional(),
  })
  .refine((b) => Boolean(b.workflow) !== Boolean(b.steps), {
    message: 'provide either "workflow" or "steps", not both',
  });

const pickSchema = z.object({
  runId: z.string().min(1),
});

const planSchema = z.object({
  // Same bound as `startRunSchema.task` — this flows into `planChain` (#429).
  task: z.string().trim().min(1).max(100_000, 'must be at most 100000 characters'),
});

// A saved workflow carries full `steps` OR the builder's `skills` stack
// (spec 012). `overwrite: true` is the builder's Save on an existing file —
// the GUI asks first; a plain POST still refuses to clobber.
const saveWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    // Written into a YAML file on disk (#429) — a workflow description is a
    // short blurb, so a 2k cap is generous without allowing a file-bloat write.
    description: z.string().max(2_000, 'must be at most 2000 characters').optional(),
    steps: z.array(workflowStepSchema).min(1).max(8).optional(),
    skills: z.array(z.string().trim().min(1)).min(1).max(8).optional(),
    overwrite: z.boolean().optional(),
  })
  .refine((b) => Boolean(b.steps) !== Boolean(b.skills), {
    message: 'provide either "steps" or "skills", not both',
  });

const parseWorkflowSchema = z.object({
  yaml: z.string().min(1).max(100_000),
});

// Small GUI preferences persisted in `.ai/cezar/ui-state.json` (files, not a
// DB): today just the last-used task source, so the form preselects what you
// actually run. Unknown keys pass through — future prefs won't need a schema
// dance.

/** Entry cap on the `skillUsage` map (#408). A real skill catalog is dozens of entries; this
 *  bounds the ui-state.json write without ever rejecting a legitimate one. */
const SKILL_USAGE_MAX_ENTRIES = 200;

// Belt-and-braces cap on the number of top-level ui-state keys so a
// `.passthrough()` schema can't accumulate an unbounded key set (#429). Very
// generous for GUI prefs; over-limit is a 400, never a silent strip. Shared by
// BOTH ui-state routes (per-repo and workspace) via `parseUiStateBody`.
const UI_STATE_MAX_KEYS = 200;

/** Settings → Appearance (redesign R6): accent + density + reading width. ONE
 *  schema for both ui-state files — per-repo (the legacy home, kept so an older
 *  cezar in the same repo still honours it) and workspace
 *  (`~/.cezar/ui-state.json`, its post-migration home — multi-project spec,
 *  Data Model).
 *
 *  Every key is `.optional()` so an older ui-state.json parses unchanged, but
 *  each one must be listed HERE: the enclosing `workspaceUiStateSchema` is
 *  `.passthrough()` at the top level only, so an unlisted key inside
 *  `appearance` is stripped by zod and then wiped from the file by the shallow
 *  merge-on-write. The cockpit adopts the PUT response as authoritative, so a
 *  stripped key does not merely fail to persist — it visibly reverts the
 *  control the user just touched. Adding an appearance preference means adding
 *  it here in the same change. */
const appearanceSchema = z.object({
  accent: z.enum(['lime', 'violet']).optional(),
  density: z.enum(['comfortable', 'compact', 'ultra']).optional(),
  width: z.enum(['narrow', 'wide']).optional(),
});

const providerAuthDismissalsSchema = z
  .object({
    claude: z.string().min(1).max(128).optional(),
    codex: z.string().min(1).max(128).optional(),
    opencode: z.string().min(1).max(128).optional(),
  })
  .strict();

/** Global GUI state (`~/.cezar/ui-state.json`, step 2.7) — the workspace twin
 *  of `uiStateSchema` below, sharing its `.passthrough()` + key-cap + shallow
 *  merge-on-write semantics via `parseUiStateBody`. Known keys are the
 *  cross-project prefs from the spec's Data Model; everything project-scoped
 *  (githubView, prompt templates, dismissed banners…) stays per-repo. */
const workspaceUiStateSchema = z
  .object({
    appearance: appearanceSchema.optional(),
    notifications: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
    dismissedProviderAuthFailures: providerAuthDismissalsSchema.optional(),
    // Sidebar per-project collapse map, keyed by project id (slug ≤ 64 chars).
    // Entry-capped like `skillUsage`: the map is written straight to a file the
    // cockpit GETs on every load, so it must stay bounded on every axis.
    sidebar: z
      .object({
        collapsed: z
          .record(z.string().min(1).max(64), z.boolean())
          .refine((map) => Object.keys(map).length <= UI_STATE_MAX_KEYS, {
            message: `sidebar.collapsed must have at most ${UI_STATE_MAX_KEYS} entries`,
          })
          .optional(),
      })
      .passthrough()
      .optional(),
    // The user's curated selection of default (vendor) skills — `open-mercato/skills` — so the
    // catalog is no longer forced in full. GLOBAL (here, not per-repo) because "which skills I
    // want" describes the person, not a checkout, and must not depend on where cezar was launched
    // (multi-project workspace). Tri-state, enforced in `discoverSkills`: an ABSENT key means "not
    // curated" and every default skill still shows (opt-out default — no silent break on upgrade);
    // a PRESENT array (even `[]`) shows only those names. Bounded like the `skillUsage` map: the
    // file is GET/PUT wholesale, so an unbounded array is an unbounded write. Names match
    // `lastTask.ref` (`.min(1).max(200)`). The client PUTs the whole array (shallow top-level merge).
    importedSkills: z
      .array(z.string().min(1).max(200))
      .max(SKILL_USAGE_MAX_ENTRIES)
      .optional(),
  })
  .passthrough();

const uiStateSchema = z
  .object({
    lastTask: z
      .object({
        source: z.enum(['workflow', 'skill']),
        ref: z.string().min(1).max(200),
      })
      .optional(),
    // Composer picker recency (newest first, capped) + the remembered worktree
    // choice for single-skill runs. Additive prefs, like the rest of ui-state.
    recentSources: z
      .array(
        z.object({
          source: z.enum(['workflow', 'skill']),
          ref: z.string().min(1).max(200),
        }),
      )
      .max(50)
      .optional(),
    lastWorktree: z.boolean().optional(),
    lastAutonomous: z.boolean().optional(),
    lastGenerateFollowups: z.boolean().optional(),
    // Skill selection frequency (#408): name → times chosen, incremented on a successful run
    // start from EITHER composer (`/new`'s SourcePill and the follow-up `SkillsPicker`). Drives
    // the shared `orderSkillsByUsage` sort (web/app/src/lib/skills.ts) so both pickers float the
    // skills a user actually reaches for above the rest, within the existing project-first
    // grouping. ADDITIVE, like the rest of ui-state — the client always PUTs the whole map
    // because the top-level merge below is shallow.
    //
    // Bounded on all three axes (key length, value, entry count) like every neighbour here: this
    // map is written straight to `ui-state.json`, which the cockpit GETs on every load and this
    // route re-reads on every PUT, so an unbounded map is an unbounded file write. Keys are skill
    // names (`.min(1).max(200)`, matching `lastTask.ref`); SKILL_USAGE_MAX_ENTRIES sits far above
    // any real catalog while capping the file at a few tens of KB.
    skillUsage: z
      .record(z.string().min(1).max(200), z.number().int().min(0).max(1_000_000))
      .refine((usage) => Object.keys(usage).length <= SKILL_USAGE_MAX_ENTRIES, {
        message: `skillUsage must have at most ${SKILL_USAGE_MAX_ENTRIES} entries`,
      })
      .optional(),
    // Runs area presentation (#348): the sidebar-list + detail pane, or the
    // full-width table ("task manager") view.
    runsView: z.enum(['list', 'table']).optional(),
    // The GitHub tab's last-selected sub-tab (#417): issues or PRs. ADDITIVE — an old
    // ui-state.json without the key behaves as the default (issues).
    githubView: z.enum(['issues', 'prs']).optional(),
    // Settings → Appearance (redesign R6): accent + density. ADDITIVE — the theme itself
    // stays in the browser (`cez-theme` localStorage, pre-paint). The cockpit always PUTs
    // the whole object because the top-level merge below is shallow.
    appearance: appearanceSchema.optional(),
    // Follow-up prompt templates (#413): reusable snippets insertable into the GitHub hand-over
    // and Inbox follow-up composers. Absent → the client's built-in defaults; present (even `[]`)
    // is the user's own edited list, from Settings → Prompt templates. Additive, like the rest of
    // ui-state — the cockpit is the only writer, so validation stays generous but bounded.
    promptTemplates: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().trim().min(1).max(80),
          text: z.string().trim().min(1).max(2000),
          // Skill names this template auto-applies for. Optional and additive: templates
          // written before this key existed keep validating, and stay manual-only.
          skills: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
        }),
      )
      .max(50)
      .optional(),
    // Skills promo banner (#391): set once the cockpit banner is dismissed, never unset.
    // Server-persisted (not a cookie) so the "shown once" promise holds across browsers.
    // Retained for backward compatibility — the banner is gone, replaced by the workspace-level
    // `importedSkills` curation (see `workspaceUiStateSchema`); `.passthrough()` would preserve
    // the key regardless, but keep it typed.
    dismissedSkillsBanner: z.boolean().optional(),
  })
  .passthrough();

// Editable titles (#389), and the initial prompt while the run is still queued
// (#472 — rejected with 409 on any other status by the handler).
const patchRunSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  task: z.string().trim().min(1).max(100_000).optional(),
});

// Session commit (redesign R5 — §"Git/session API additions").
const gitCommitSchema = z.object({
  message: z.string().trim().min(1, 'must not be empty').max(5_000),
});

// "Open in…" (#open-in / #365): `target` selects the app; `path` (optional, worktree-relative)
// narrows the target's own worktree/repo-root default to one file — used by the diff pane's
// "open in default app" action for images. Containment is re-checked server-side via
// `readWorktreePath`; this schema only shapes the request.
const openInSchema = z.object({
  // A short bound (#429): matched against a downstream allowlist, so an editor id is never long.
  target: z.string().trim().min(1, 'target required').max(200),
  path: z.string().max(1_000).optional(),
});

const imageInputSchema = z.object({
  mediaType: z.string().regex(/^image\//),
  // ~5 MB per image once base64-decoded.
  data: z.string().min(1).max(7_000_000),
});

const messageSchema = z
  .object({
    text: z.string().max(100_000).default(''),
    images: z.array(imageInputSchema).max(4).default([]),
  })
  .refine((m) => m.text.trim().length > 0 || m.images.length > 0, {
    message: 'message needs text or at least one image',
  });

// PATCH semantics are load-bearing here: an omitted field keeps its current value.
// In particular, the cockpit edits text without re-uploading existing attachments.
const queuedMessagePatchSchema = z
  .object({
    text: z.string().max(100_000).optional(),
    images: z.array(imageInputSchema).max(4).optional(),
  })
  .refine((m) => m.text !== undefined || m.images !== undefined, {
    message: 'message edit needs text or images',
  });

// Queued prompt stack bounds (#472). The per-message bounds mirror `messageSchema`
// above; the one that actually matters is the FOLDED total, because 20 messages of
// 100 000 chars each would otherwise compose a ~2 M-character {{task}}.
const MAX_QUEUED_MESSAGES = 20;
const MAX_QUEUED_IMAGES = 8;
const MAX_FOLDED_TASK_CHARS = 200_000;

/** Length of the prompt a run would execute with — `task` plus its whole stack,
 *  composed exactly as `hydrateQueuedInput` composes it. Checked against the
 *  PROSPECTIVE state so the user is stopped at the write, not at dequeue where
 *  there would be no one left to tell. */
function foldedLength(task: string, stack: Array<{ text: string }>): number {
  return [task, ...stack.map((m) => m.text)]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n').length;
}

// "Continue"/"Send back" body (spec 003 / #401): every field optional, so an empty POST reopens
// the last session on the run's current backend (backward compat). A runner/model override lets
// the follow-up composer choose which engine handles the continuation. `text` stays bounded like
// the live-session message `text` (#429), and `images` like a live-session message's — the
// follow-up composer is a full composer, so a screenshot pasted into it must reach the reopened
// session rather than being silently dropped.
const continueSchema = z.object({
  text: z.string().max(100_000, 'must be at most 100000 characters').optional(),
  images: z.array(imageInputSchema).max(4).optional(),
  runner: z.enum(['claude', 'codex', 'opencode']).optional(),
  model: z.string().max(200).optional(),
});

// Inbox "▶ Run" body (spec 007 / #401 / #413): every field optional, and the whole body is
// optional too, so an empty POST — every client before the pills and the composer — starts on
// the host's `defaultRunner` with no extra instructions, exactly as before. This is a START
// path, not a continue: there is no prior backend to preserve, so an omitted `runner`/`model`
// means "host default" rather than "keep what the run had". `prompt` (#413) is extra
// instructions appended to the entry's suggested/summary task text; whitespace-only degrades to
// absent so it never touches `task`.
const startTodoSchema = z
  .object({
    runner: z.enum(['claude', 'codex', 'opencode']).optional(),
    model: z.string().max(200).optional(),
    prompt: z
      .string()
      .trim()
      .max(20_000, 'must be at most 20000 characters')
      .optional()
      .transform((s) => (s ? s : undefined)),
  })
  .optional();

/** Hono env for `POST /todos/:id/start`: the guard in front of that route publishes the resolved
 *  entry so the handler does not re-read `todos.json` a second time in the same request. */
type TodoStartEnv = ProjectApiEnv & { Variables: { todo: TodoItem } };

// `POST /api/runs/:id/archive` (#429) — no body archives; `{archived:false}`
// un-archives. A tiny schema so the route follows the safeParse convention.
const archiveSchema = z.object({
  archived: z.boolean().optional(),
});

// Request-body size guards (#429). A generous global cap keeps a single
// localhost request from being unbounded (the largest legit body is 4 pasted
// images at ~7 MB base64 each); the ui-state PUT gets a much tighter cap since
// it only ever carries small GUI prefs.
const GLOBAL_BODY_LIMIT = 32 * 1024 * 1024; // 32 MiB
const UI_STATE_BODY_LIMIT = 128 * 1024; // 128 KiB

/** The name half of a Host header — `localhost:4321` → `localhost`,
 *  `[::1]:4321` → `[::1]`. A bracketed IPv6 literal keeps its brackets
 *  (`isLoopbackHost` strips them itself); an unbracketed IPv6 spelling is
 *  nonstandard in a Host header and simply fails the loopback test closed. */
function stripHostPort(host: string): string {
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(host);
  if (bracketed?.[1]) return bracketed[1];
  return host.replace(/:\d+$/, '');
}

/** The shared write-side half of BOTH ui-state routes (per-repo `/api/v1/ui-state`
 *  and workspace `/api/v1/workspace/ui-state`) — the factored split the
 *  multi-project spec calls for instead of a copy: the route's own schema, plus a
 *  cap on the top-level key count so a `.passthrough()` schema can't accumulate an
 *  unbounded key set (#429). The cap rides as a refinement so the whole thing is one
 *  schema and can go through `jsonBody` like every other mutating route. The
 *  merge-on-write stays with each route (they write different files) but is shallow
 *  in both. */
function capUiStateKeys(data: unknown, ctx: z.RefinementCtx): void {
  if (Object.keys(data as Record<string, unknown>).length > UI_STATE_MAX_KEYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `ui-state has too many keys (max ${UI_STATE_MAX_KEYS})` });
  }
}

// Derived once per route instead of by a generic `wrap(schema)` helper called at the route: a
// generic wrapper leaves the schema type unresolved where `jsonBody` needs it, and Hono answers
// that by dropping the whole PUT from the route schema rather than erroring — both ui-state PUTs
// silently vanished from `AppType`. Concrete consts keep them visible to `hc`.
const workspaceUiStateBody = workspaceUiStateSchema.superRefine(capUiStateKeys);
const uiStateBody = uiStateSchema.superRefine(capUiStateKeys);

/**
 * Query schemas for the READ routes — deliberately permissive.
 *
 * These exist to make a query key VISIBLE to the route type (`hc` refuses a `query` argument for
 * a key no validator declares), NOT to narrow what the route accepts. Every one of these handlers
 * compares `=== '1'` and treats everything else as false, so `?refresh=0` is a successful request
 * today; a literal schema would silently turn it into a 400. The comparison stays in the handler
 * and the validator stays out of its way.
 *
 * The one route that really is strict on the wire — `GET /github/prs/:number/changes`, which 400s
 * on `?refresh=true` — keeps its own `z.enum(['1'])` schema next to the route.
 */
/**
 * One query value, matching what `c.req.query('k')` did before these routes were validated.
 *
 * Hono's query validator hands a REPEATED key as an array (`?wait=1&wait=1` → `['1','1']`), where
 * `c.req.query()` silently took the first. A plain `z.string()` therefore turns a request that
 * used to answer 200 into a 400 — a wire change no caller asked for. Collapsing to the first
 * value keeps the old behaviour, and the client still sees a plain `key?: string`.
 */
const queryValue = z.union([z.string(), z.array(z.string()).transform((v) => v[0] as string)]).optional();

const refreshQuery = z.object({ refresh: queryValue });
const waitQuery = z.object({ wait: queryValue });

/**
 * HTTP content negotiation for the two routes that serve more than one FORMAT on one path:
 * `GET /repo/commit/:sha` (a structured payload or the legacy text blob) and
 * `GET /runs/:id/files` (a JSON listing/metadata or an image file's BYTES).
 *
 * ## Precedence — flag, then Accept, then the route's own default
 *
 * 1. **The query flag wins whenever the request carries it.** `?structured=1` and `?raw=1` are the
 *    live wire and a protected surface (BACKWARD_COMPATIBILITY.md §2); `Accept` is ADDITIVE and
 *    may never override a caller that said what it wanted in the URL. The flag counts as "carried"
 *    when the key is PRESENT, so `?raw=0` is an explicit opt-out of the raw representation and not
 *    an invitation to re-decide from a header.
 * 2. **Otherwise the best `Accept` match** among the representations that route offers.
 * 3. **Otherwise the route's established default** — the text blob for `/repo/commit/:sha`, the
 *    JSON listing for `/runs/:id/files` — i.e. exactly what a pre-Accept client received.
 *
 * `*<slash>*` matches NOTHING here, deliberately: it is what `fetch`, `curl` and XHR send when
 * they have no preference at all, and treating "anything" as a preference would silently change
 * the default representation of both routes for every existing caller. A browser that navigates to
 * a worktree image DOES get the bytes, because its `Accept` really does ask for `image/*` at q=1 —
 * the same protections ride along (image extensions only, size cap, `nosniff`, sandbox CSP).
 *
 * Both routes answer `Vary: Accept`, since a cache that ignored the header would serve one
 * representation for the other.
 */
type MediaRange = { type: string; subtype: string; q: number };

function parseAccept(header: string): MediaRange[] {
  const ranges: MediaRange[] = [];
  for (const part of header.split(',')) {
    const [range = '', ...params] = part.split(';');
    const [type = '', subtype = ''] = range.trim().toLowerCase().split('/');
    if (type === '' || subtype === '') continue;
    const weight = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    const parsed = weight === undefined ? 1 : Number.parseFloat(weight.slice(2));
    const q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    if (q > 0) ranges.push({ type, subtype, q });
  }
  return ranges;
}

/**
 * The best of `offers` for this `Accept`, or `null` for "no preference expressed" — which is what
 * an absent header, a `*<slash>*`-only header and a header naming nothing on offer all mean, and
 * what leaves the caller on its route's default.
 *
 * `offers` is the server's own preference order: an offer may itself be a wildcard (`image/*`,
 * since the concrete image type is not known until the file is read), and equal q-values go to the
 * EARLIER offer, so each route lists its default representation first.
 */
function negotiate<O extends string>(accept: string | undefined, offers: readonly O[]): O | null {
  if (accept === undefined) return null;
  const ranges = parseAccept(accept);
  let best: { offer: O; q: number } | null = null;
  for (const offer of offers) {
    const [type = '', subtype = ''] = offer.split('/');
    let q = 0;
    for (const range of ranges) {
      if (range.type === '*' && range.subtype === '*') continue; // "anything" is not a preference
      const typeMatches = range.type === type || range.type === '*' || type === '*';
      const subtypeMatches = range.subtype === subtype || range.subtype === '*' || subtype === '*';
      if (typeMatches && subtypeMatches && range.q > q) q = range.q;
    }
    if (q > 0 && (best === null || q > best.q)) best = { offer, q };
  }
  return best?.offer ?? null;
}

/** What `GET /repo/commit/:sha` offers, DEFAULT FIRST: the legacy `text/plain` blob is what a
 *  request with no opinion has always received (§2), so it also wins an Accept tie. */
const COMMIT_FORMATS = ['text/plain', 'application/json'] as const;

/** What `GET /runs/:id/files` offers, DEFAULT FIRST. `image/*` rather than a concrete type: which
 *  image type the bytes are is only known once the path resolves, and the raw branch refuses
 *  everything that is not an image anyway. */
const FILE_FORMATS = ['application/json', 'image/*'] as const;

/** Workspace-root writability probe (multi-project spec, "API Contracts"):
 *  optional `mkdir -p`, `access W_OK`, then a real create/delete round-trip — W_OK alone
 *  can lie (e.g. a read-only mount still reports writable permission bits).
 *  Returns the failure message, or null when the directory is usable. */
async function probeWritableDir(dir: string, create: boolean): Promise<string | null> {
  const probe = join(dir, `.cez-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    if (create) await mkdir(dir, { recursive: true });
    const info = await stat(dir);
    if (!info.isDirectory()) return `${dir} is not a directory`;
    await access(dir, fsConstants.W_OK);
    await writeFile(probe, '', 'utf8');
    await unlink(probe);
    return null;
  } catch (err) {
    await unlink(probe).catch(() => {}); // best-effort if the round-trip half-succeeded
    return err instanceof Error ? err.message : String(err);
  }
}

// The return type is INFERRED on purpose: it is the chained app type built at the bottom of
// this function, and `AppType` (src/server/app-type.ts) is `ReturnType<typeof createApp>`.
// Annotating it `Hono` here would erase every route from the type and leave the typed client
// with nothing to offer. See the `routed` assembly at the end of the function.
export function createApp(deps: ServerDeps) {
  const { version, update, bindHost, bootProjectId } = deps;
  // Boot singletons keep DELIBERATELY distinct names (`boot*`): every
  // project-scoped handler must resolve its `{store, manager, root, dataDir,
  // launchKey}` from `c.get('project')` — a bare `store`/`repoRoot` in a
  // handler body would silently pin it to the boot project, which the rename
  // turns into a compile error instead.
  const bootRoot = deps.repoRoot;
  const bootDataDir = join(bootRoot, '.ai/cezar');
  const modelCatalog = deps.modelCatalog ?? new RunnerModelCatalog({
    adapters: { codex: { discover: () => discoverCodexModels({ cwd: bootRoot }) } },
  });
  const providerAuth = deps.providerAuth ?? new ProviderAuthService();
  const workspaceConfig = deps.workspaceConfig ?? {
    load: loadWorkspaceConfig,
    mergeWrite: mergeWriteWorkspaceConfig,
  };
  const providerStatus = async (options?: { refresh?: boolean }): Promise<ProviderStatusResponse> => {
    const [discovered, workspace] = await Promise.all([
      providerAuth.status(options?.refresh ? { refresh: true } : undefined),
      workspaceConfig.load(),
    ]);
    return applyProviderEnablement(discovered, workspace.disabledProviders);
  };
  const providerActionError = async (
    required: readonly ProviderId[],
  ): Promise<string | null> => unavailableProviderMessage(required, await providerStatus());
  const openTerminal = deps.openTerminal ?? openInTerminal;
  const skillsUpdate = deps.skillsUpdate ?? new SkillsUpdateService();

  // ---- workspace boot-project identity (multi-project spec) ----------------
  // The boot flow (`initWorkspace` in src/index.ts) registers the boot repo
  // and plumbs its registry id in via `deps.bootProjectId`. Legacy callers and
  // tests construct the app without one — then it is derived lazily from the
  // registry by realpath and cached on a hit. A boot repo that is legitimately
  // unregistered (task worktree, `$HOME` itself, unreadable workspace) falls
  // back to its would-be slug, so `bootProject` always names the repo this
  // server was started in. Strictly non-fatal, zero-config: every failure path
  // degrades to the slug fallback, never an error.
  let bootProjectCache = bootProjectId;
  const resolveBootProject = async (projects?: readonly WorkspaceProject[]): Promise<string> => {
    if (bootProjectCache) return bootProjectCache;
    let registry = projects ?? [];
    try {
      registry = projects ?? (await loadWorkspaceConfig()).projects;
      const real = await realpath(bootRoot).catch(() => bootRoot);
      const match = registry.find((p) => p.root === real || p.root === bootRoot);
      if (match) bootProjectCache = match.id;
    } catch {
      // unreadable workspace — fall through to the slug fallback below
    }
    return bootProjectCache ?? allocateProjectSlug(bootRoot, registry.map((project) => project.id));
  };
  // Health's workspace garnish: id+name ONLY — never `root` (#431, see the
  // health route). Reads only the registry file; no per-root status probes,
  // so health stays cheap enough for the bookmarklet's 800 ms port sweep.
  const workspaceSummary = async (): Promise<{
    projects: { id: string; name: string }[];
    bootProject: string;
  }> => {
    try {
      const registry = (await loadWorkspaceConfig()).projects;
      const bootProject = await resolveBootProject(registry);
      const visible = capabilities().singleProject
        ? registry.filter((project) => project.id === bootProject)
        : registry;
      return {
        // Explicit picks, not a spread: the registry schema passes unknown
        // keys through, and `root` must never ride along onto health.
        projects: visible.map((p) => ({
          id: p.id,
          name: p.name || basename(p.root),
        })),
        bootProject,
      };
    } catch {
      return { projects: [], bootProject: await resolveBootProject([]) };
    }
  };
  // Hosted-mode gate (spec §"Deployment modes") — read per request so
  // CEZ_REMOTE flips take effect live (and tests can toggle it).
  const capabilities = () => resolveCapabilities(process.env, bindHost);
  const singleProjectRefusal = (
    action: 'adding projects' | 'editing projects' | 'removing projects' | 'folder browsing',
  ) => ({ error: `single-project mode is enabled; ${action} is disabled` });
  // Inbox live updates (spec 007). Opt-in (#471): no capability, no watcher —
  // and since step 2.3 the per-dataDir watch is created lazily by the first
  // SSE subscription (and torn down with the last), nothing to start here.

  // ---- project contexts (multi-project spec, step 2.2) ---------------------
  // The boot project's context is SEEDED from the deps the caller already
  // built (src/index.ts `serveCommand` did the recover/prune/launch-key work
  // at startup — observable boot behavior unchanged); it never enters the
  // lazy map, so its `.ai/cezar` state is never double-opened. `id` starts as
  // the reserved alias when registration was suppressed — handlers never read
  // it; API payloads name the boot project via `resolveBootProject` instead.
  const bootContext: ProjectContext = {
    id: bootProjectId ?? 'default',
    root: bootRoot,
    dataDir: bootDataDir,
    store: deps.store,
    manager: deps.manager,
    automationStore: deps.automationStore ?? AutomationStore.open(bootDataDir),
    launchKey: ensureLaunchKey(bootDataDir), // bookmarklet auto-start secret (spec 011)
  };
  // Non-boot projects build lazily on first scoped request; their managers
  // count against the same workspace semaphore as the boot manager (step 2.5).
  const contexts = deps.contexts ?? new ProjectContexts({
    listProjects: async () => {
      const selector = capabilities().singleProject
        ? { projectId: await resolveBootProject() }
        : undefined;
      return listProjects(selector);
    },
    semaphore: deps.semaphore,
  });
  // Workspace-level SSE bus (step 2.8) — the registry mutators and the
  // checkout flow (Phase 4) emit here; /api/workspace/events relays.
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  const emitAutomationChange = (
    project: ProjectContext,
    automationId: string,
    revision: number,
    deleted = false,
  ) => workspaceEvents.emit('automation-change', {
    project: project.id,
    automationId,
    revision,
    ...(deleted ? { deleted: true } : {}),
  });
  const automationsChanged = () => deps.automationsChanged?.();

  const providerRuntimeAuth = deps.providerRuntimeAuth
    ?? new ProviderRuntimeAuthObserver(providerAuth, (status) => {
      workspaceEvents.emit('provider-status', status);
    });

  providerRuntimeAuth.watch(bootContext.store);
  for (const id of contexts.ids()) {
    const ctx = contexts.peek(id);
    if (ctx) providerRuntimeAuth.watch(ctx.store);
  }
  contexts.onStoreCreated((store) => providerRuntimeAuth.watch(store));
  contexts.onContextBuilt((ctx) => providerRuntimeAuth.watch(ctx.store));

  const app = new Hono();

  // Reject oversized request bodies before they reach any handler (#429). GETs
  // and SSE carry no body, so this only ever gates the mutating routes.
  app.use('*', bodyLimit({ maxSize: GLOBAL_BODY_LIMIT }));

  // ---- request-origin guard (#426) -----------------------------------------
  // This server executes agents with shell access — "start a task" ≈ run code
  // as the user — so "bind 127.0.0.1 + same-origin" is not a perimeter on its
  // own: any page the user visits can still POST to us (CSRF), and DNS
  // rebinding can point a foreign domain at loopback and read our responses.
  // Two zero-config checks close both holes on every /api route EXCEPT
  // /api/v1/health (the intentional cross-origin discovery endpoint, spec 011 —
  // it exposes nothing sensitive, see #431):
  //   1. Host allowlist (loopback deployments only) — a request whose Host is
  //      not a loopback name did not really originate from this machine. A
  //      rebound `evil.com` still sends `Host: evil.com`, so this kills DNS
  //      rebinding for reads AND writes. Skipped in hosted mode (CEZ_REMOTE /
  //      non-loopback bind), where the reverse proxy forwards the real public
  //      Host and TLS+auth own the perimeter.
  //      The match runs through `isLoopbackHostHeader`, whose 127.0.0.0/8 test
  //      is *anchored* and whose missing-Host answer is "untrusted". Both are
  //      load-bearing: a `startsWith('127.')` prefix would accept the
  //      attacker-registrable `127.0.0.1.evil.com`, and such a page is really
  //      same-origin with us, so checks 2 and 3 would wave it through too.
  //   2. Same-origin write guard — a cross-origin write always carries an
  //      `Origin` header (browsers attach it to every non-GET), so its full
  //      authority (host AND port) must match the served Host. A blind CSRF
  //      POST from evil.tld is rejected; the cockpit's own same-origin fetch
  //      (Origin === Host, or no Origin at all for non-browser callers) passes
  //      untouched. Works in both local and hosted mode because it compares
  //      Origin to the actual Host.
  // Scope note: check 2 covers writes only. A cross-origin GET from any site
  // still reaches the read routes — but its Host is ours, so it is a *forced
  // request*, not a read: the same-origin policy stops the attacker seeing any
  // response body (we send CORS headers on /api/v1/health alone), and no GET
  // handler mutates state. Rebinding, which WOULD make those reads legible, is
  // what check 1 stops.
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const isHostedMode = () => !resolveCapabilities(process.env, bindHost).localHandoff;
  app.use('/api/*', async (c, next) => {
    const hostName = hostnameOfHost(c.req.header('host'));
    // Strict twin of `isLoopbackHost`: a *missing* Host is untrusted here (an
    // absent header is not the "we defaulted to the loopback bind" case), and
    // the loopback match is anchored so `127.0.0.1.evil.com` does not pass.
    if (!isHostedMode() && !isLoopbackHostHeader(hostName)) {
      return c.json(
        {
          error: 'forbidden: unexpected Host header — this request did not originate from this machine (see #426)',
        },
        403,
      );
    }

    // /api/v1/health stays CORS-open for cross-origin discovery, but its Host is
    // still checked above: cross-origin is legitimate, DNS rebinding is not. The
    // path is spelled through V1_PREFIX rather than inline — an unversioned
    // literal here silently stopped matching when the API moved and left health
    // relying on the mutating-methods gate below to let its GETs through.
    if (c.req.path === `${V1_PREFIX}/health`) return next();

    if (MUTATING_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        const originHost = hostnameOfOrigin(origin);
        // Compare the whole authority, not just the hostname: a different PORT
        // is a different web origin, and on a dev machine `http://localhost:3000`
        // is every bit as foreign as `https://evil.tld`. Matching on hostname
        // alone would let any page served from another loopback port (a local
        // dev server rendering attacker content, an XSS in a local app) start a
        // shell-capable agent here.
        const sameOrigin = !!originHost && authorityOfOrigin(origin) === authorityOfHost(c.req.header('host'));
        // The one legitimate cross-port case is the `npm run dev` Vite proxy:
        // the browser fetches same-origin from `localhost:5173`, Vite's
        // `changeOrigin` rewrites Host to `127.0.0.1:<api port>` but forwards
        // the original Origin, so the authorities no longer line up. The browser
        // already told us what it thinks: `Sec-Fetch-Site: same-origin` is a
        // forbidden header name that page JS cannot set, and a cross-port
        // attacker page gets `same-site`, never `same-origin`. Requiring it
        // (plus loopback on both ends) readmits the proxy without readmitting
        // the attack. Browsers too old to send Sec-Fetch metadata simply fail
        // closed here — they still work against a non-proxied cockpit.
        const isDevProxy =
          c.req.header('sec-fetch-site') === 'same-origin' &&
          isLoopbackHostHeader(originHost) &&
          isLoopbackHostHeader(hostName);
        if (!sameOrigin && !isDevProxy) {
          return c.json(
            {
              error: 'forbidden: cross-origin request rejected (same-origin only)',
            },
            403,
          );
        }
      }
      // Belt-and-suspenders for browsers that send Sec-Fetch metadata: an
      // explicit cross-site marker is rejected regardless of the Origin dance.
      if (c.req.header('sec-fetch-site') === 'cross-site') {
        return c.json(
          {
            error: 'forbidden: cross-site request rejected (same-origin only)',
          },
          403,
        );
      }
    }
    return next();
  });

  // The mirrored project-route table (spec "API Contracts → Project-scoped").
  // Every route below registers ONCE on this sub-app; `createApp` mounts it
  // twice — under `/api/v1/p/:projectId` (scoped) and under `/api/v1` (bound to
  // the boot project) — so both spellings share one handler and can never
  // drift. The resolver middleware binds `c.get('project')`:
  // no `projectId` param (unscoped mount) → the boot context, byte-identical to
  // the pre-workspace closures; `default` or the boot project's own id → the
  // boot context too; anything else → the lazy context map, with
  // `ProjectContextError` mapped to 404 (unknown) / 409 (missing root).
  // Named rather than inlined because both mounts share it — one function, so
  // the two spellings can never disagree about what `default` means.
  const resolveProjectScope = async (c: Context<ProjectApiEnv>, next: Next): Promise<Response | void> => {
    const raw = c.req.param('projectId');
    if (raw === undefined) {
      c.set('project', bootContext);
      return next();
    }
    if (!projectIdSchema.safeParse(raw).success) {
      return c.json({ error: `unknown project: ${raw}` }, 404);
    }
    if (raw === 'default' || raw === (await resolveBootProject())) {
      c.set('project', bootContext);
      return next();
    }
    try {
      c.set('project', await contexts.context(raw));
    } catch (err) {
      if (err instanceof ProjectContextError) {
        return err.reason === 'missing-root'
          ? c.json({ error: `project folder not found: ${err.projectId}` }, 409)
          : c.json({ error: err.message }, 404);
      }
      throw err;
    }
    return next();
  };

  // ---- static GUI ----------------------------------------------------------
  const webDir = resolveWebDir();
  const distDir = join(webDir, 'dist');
  const HTML_TYPE = 'text/html; charset=utf-8';
  const staticFile = (name: string, type: string) => (c: Context): Response => {
    // Read per request — the files are tiny and this keeps dev iteration live.
    //
    // Served out of the Vite build: the file is a `public/` asset of the web package, which the
    // build copies verbatim into `web/dist`. One home, one URL — the same bytes this route
    // hands out are what the bundle's own `<img src="/open-mercato.svg">` asks for.
    // Without a build there is nothing to serve, which is a 404 rather than a crash (the shell
    // route answers the same dev-only state with its build hint).
    const path = join(distDir, name);
    if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
    return new Response(readFileSync(path), { headers: { 'content-type': type } });
  };

  let hintLogged = false;
  const serveShell = (c: Context): Response | undefined => {
    const distIndex = join(distDir, 'index.html');
    // existsSync per request, like the reads below: `npm run build:web` in a
    // running cockpit takes effect on the next reload, no restart.
    const target = resolveGetRequest({
      path: c.req.path,
      distExists: existsSync(distIndex),
    });
    if (target === 'passthrough') return undefined;
    if (target === 'build-hint') {
      // Dev-only state (the tarball ships web/dist): serve the built-in hint
      // page instead of the app — the legacy fallback UI was deleted in R7.
      if (!hintLogged) {
        hintLogged = true;
        console.log('cezar: web/dist is missing — run `npm run build:web` to build the cockpit');
      }
      return new Response(BUILD_HINT_HTML, {
        headers: { 'content-type': HTML_TYPE },
      });
    }
    return new Response(readFileSync(distIndex), {
      headers: { 'content-type': HTML_TYPE },
    });
  };

  // Hashed bundles/fonts of the built app. Vite fingerprints every name, so
  // the bytes behind a URL never change — cache them hard. Only plain
  // filenames are served: `basename('..')` is `'..'` (it resolves to the
  // assets dir itself and readFileSync would throw EISDIR), so dot-segments
  // and separator-bearing params get a 404, not a 500.
  app.get('/assets/:file', (c) => {
    const file = c.req.param('file');
    if (!isSafeAssetFilename(file)) return c.json({ error: 'not found' }, 404);
    const path = join(distDir, 'assets', file);
    if (!existsSync(path) || !statSync(path).isFile()) return c.json({ error: 'not found' }, 404);
    return new Response(readFileSync(path), {
      headers: {
        'content-type': assetContentType(file),
        'cache-control': ASSET_CACHE_CONTROL,
      },
    });
  });

  // The favicon packages/web/index.html points at (`/open-mercato.svg`).
  app.get('/open-mercato.svg', staticFile('open-mercato.svg', 'image/svg+xml'));

  // ---- meta ----------------------------------------------------------------
  // CORS — deliberately for /api/health ONLY (spec 011): the bookmarklets
  // fetch it cross-origin from github.com to discover which local ports run a
  // cockpit and which repo each serves. Health exposes no secrets beyond the
  // repo path/remote; every other endpoint stays same-origin.
  const healthCors = async (c: Context, next: Next): Promise<Response | void> => {
    c.header('access-control-allow-origin', '*');
    if (c.req.method === 'OPTIONS') {
      // Preflight (e.g. Chrome Private Network Access) — allow the plain GET.
      c.header('access-control-allow-methods', 'GET');
      c.header('access-control-allow-private-network', 'true');
      return c.body(null, 204);
    }
    await next();
  };
  app.use(`${V1_PREFIX}/health`, healthCors);
  // One builder for both transports: `GET /api/health` (the authoritative,
  // CORS-open discovery endpoint) and the `health` topic on `/api/v1/ws` below
  // push the byte-identical shape, so the two can never drift.
  // Deliberately UNANNOTATED: this literal is the source of the `/health` shape. Annotating it
  // with the api-client's `HealthResponse` made the contract circular — the DTO was declared by
  // hand, the handler was checked against it, and `AppType` then reported the hand-written type
  // back as if the server had proven it. Inferring here means the route says what it actually
  // sends, which is what lets the DTO be derived instead of maintained.
  const healthSnapshot = async () => {
    const [checks, repo, config, workspace] = await Promise.all([
      detectEnvironment(),
      getRepoInfo(bootRoot),
      loadConfig(bootRoot),
      workspaceSummary(),
    ]);
    // Additive fields only below — the pre-forge shape is the most
    // externally-depended-on JSON in the app (BACKWARD_COMPATIBILITY.md §2).
    const forge = resolveForge(repo);
    const caps = capabilities();
    return {
      version,
      // Spread rather than `latestVersion: update?.latest`: an `undefined` VALUE is dropped by
      // JSON.stringify, so the key is absent on the wire — but writing it unconditionally types
      // the key as always-present, which is a shape no client ever receives. The contract schema
      // says `.optional()`, and contract-parity.test.ts holds the two together.
      ...(update?.latest !== undefined ? { latestVersion: update.latest } : {}),
      // Health is CORS-open and, in hosted mode, reachable off the loopback —
      // so any site/host that reads it would learn the developer's absolute
      // checkout path and username (#431). Local mode keeps the full path (the
      // protected bookmarklet shape); hosted/remote mode trims it to a basename.
      // NB this narrows the VALUE of a field named in BACKWARD_COMPATIBILITY.md
      // §2: the field is always present and a string, but under CEZ_REMOTE it is
      // no longer an absolute path. Deliberate — a hosted cockpit's paths are on
      // a machine the reader does not have anyway. See §2's `repoRoot` note.
      repoRoot: caps.localHandoff ? bootRoot : basename(bootRoot),
      repo,
      checks,
      defaultRunner: config.defaultRunner,
      // Non-blocking: cached availability or null-until-warm — health must never pay a `gh`
      // shell-out (the bookmarklet aborts its port probe at 800 ms). See detectGithubCached.
      forge: forge ? { kind: forge.kind, ...(forge.detectCached() ?? {}) } : null,
      capabilities: caps,
      // Workspace enumeration (multi-project spec) — additive, id+name ONLY.
      // NEVER `projects[].root` here: health is the one CORS-open route, and
      // the repoRoot trim above exists precisely to keep absolute paths and
      // usernames away from cross-origin readers (#431) — per-project roots
      // would reintroduce that leak once per registered project. Absolute
      // roots live on the same-origin GET /api/projects instead. An
      // unreadable workspace degrades to `projects: []`.
      projects: workspace.projects,
      bootProject: workspace.bootProject,
    };
  };
  // ---- server-side health cache (stale-while-revalidate) -------------------
  // The snapshot is expensive: ~0.8 s of agent-CLI `--version` probes plus
  // ~0.4 s of git. Paying that on the browser's FIRST `GET /api/health` is
  // exactly the few-seconds-blank the cockpit showed at load. So on the live
  // server the snapshot is computed at the server's OWN pace: both the GET and
  // the WS `health` topic serve the cached value immediately and revalidate
  // behind the response, and the cache is pre-warmed at boot so that first
  // request lands on a warm value instead of the cold compute.
  const HEALTH_TTL_MS = 5_000;
  // The staleness CEILING, which is a different job from the TTL above. The TTL
  // decides how often a revalidation is kicked off; on its own it bounds nothing,
  // because the revalidation is fire-and-forget. While a cockpit holds the
  // `health` topic the publisher's interval keeps the cache warm and the two are
  // the same number — but the normal state of a background `cezar serve` is NO
  // subscriber, and then nothing refreshes the cache at all: the next `GET
  // /api/health`, an hour later, would answer with the boot pre-warm's payload
  // and only the request AFTER it would see the truth. That endpoint is the
  // bookmarklet contract (BACKWARD_COMPATIBILITY.md §2, "the most
  // externally-depended-on JSON in the app") and `repo.branch` going stale is
  // literally #369, so past this age correctness beats the latency win and the
  // read waits for the compute. `refreshHealth` dedupes, so waiting costs one.
  const HEALTH_MAX_STALE_MS = 60_000;
  /** Whatever `healthSnapshot` actually returns — see the note there. */
  type HealthPayload = Awaited<ReturnType<typeof healthSnapshot>>;
  let healthCache: { at: number; payload: HealthPayload; body: string } | undefined;
  let healthInFlight: Promise<HealthPayload> | undefined;
  // Set while the topic has a subscriber; a change a refresh detects is pushed
  // here (a noop when nobody is listening).
  let publishHealth: (data: unknown) => void = () => {};

  const refreshHealth = (): Promise<HealthPayload> => {
    // Dedupe: a GET's background revalidation and the topic's interval tick
    // share ONE compute (and one set of CLI spawns) rather than racing two.
    if (healthInFlight) return healthInFlight;
    healthInFlight = (async () => {
      try {
        const payload = await healthSnapshot();
        const body = JSON.stringify(payload);
        const changed = body !== healthCache?.body;
        healthCache = { at: Date.now(), payload, body };
        if (changed) publishHealth(payload); // only a real change reaches the wire
        return payload;
      } finally {
        healthInFlight = undefined;
      }
    })();
    return healthInFlight;
  };

  // The read the GET and the topic snapshot share. On the live server (a hub is
  // injected) it answers from cache instantly and revalidates behind the
  // response; without a hub — a bare app in tests — there is no refresher
  // keeping a cache coherent, so it computes fresh, exactly as before.
  const readHealth = async (): Promise<HealthPayload> => {
    if (!deps.socketHub) return healthSnapshot();
    if (!healthCache) return refreshHealth(); // first ever: nothing to serve yet
    const age = Date.now() - healthCache.at;
    if (age > HEALTH_MAX_STALE_MS) return refreshHealth(); // too old to serve — wait for the truth
    if (age > HEALTH_TTL_MS) void refreshHealth(); // stale: refresh, don't wait on it
    return healthCache.payload;
  };

  // ---- chained family: health (workspace-level) ----------------------------
  // Written as ONE chained expression rather than a loose `app.get(...)`
  // statement because Hono accumulates its route types through the chain: a
  // statement's return value is discarded, so `typeof app` would record nothing
  // and `hc<AppType>` would have no endpoint to offer. `createApp` mounts this
  // under both `/api` (the frozen legacy spelling) and `/api/v1`.
  const healthRoutes = new Hono().get('/health', async (c) => c.json(await readHealth()));

  // The push twin of the poll it replaced (#369): while at least one cockpit
  // holds the `health` topic the server re-reads the snapshot on the old 5 s
  // cadence and broadcasts ONLY when it changed — a `git checkout` in a
  // terminal reaches every open tab within a tick — and an idle workspace (no
  // subscriber) runs no timer. Nothing server-side watches `.git/HEAD`, so the
  // interval stays the honest mechanism; it just lives behind the socket now
  // instead of N tabs × 5 s HTTP polls. Every tick and every subscriber read
  // goes through the cache above, so N subscribers still cost one compute.
  deps.socketHub?.registerTopic(
    'health',
    {
      snapshot: readHealth,
      start: (publish) => {
        publishHealth = publish;
        const timer = setInterval(() => void refreshHealth(), HEALTH_TTL_MS);
        timer.unref?.();
        return () => {
          clearInterval(timer);
          publishHealth = () => {};
        };
      },
    },
    // health IS the CORS-open discovery payload (#431), so it is the one topic
    // safe for any local page — including a cross-port page admitted by the
    // loopback fallback on a no-Sec-Fetch browser. Every other (future) topic
    // keeps the default: trusted connections only.
    { loopbackReadable: true },
  );
  // Pre-warm on the live-server path only (startServer injects the hub; a bare
  // app in tests does not, so tests never spawn the probes here): the cache
  // fills while the browser is still downloading the bundle, so its first
  // `GET /api/health` reads a warm value instead of the cold ~1 s compute.
  if (deps.socketHub) void refreshHealth();

  // ---- chained family: host model catalog (workspace-level) ----
  const modelsRoutes = new Hono<ProjectApiEnv>()
    .get('/models', queryZodValidator(z.object({ runner: z.union([z.string(), z.array(z.string()).transform((v) => v[0] as string)]).pipe(z.literal('codex')) }), { message: 'runner must be codex' }), async (c) => {
      const query = { data: c.req.valid('query') };
      return c.json(await modelCatalog.get(query.data.runner));
    });

  // ---- chained family: agent providers (workspace-level) ----
  const providersRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/providers/status',
      queryZodValidator(z.object({ refresh: queryValue.refine((v) => v === undefined || v === '1') }), { message: 'refresh must be 1 when provided' }),
      async (c) => {
        const query = { data: c.req.valid('query') };
        return c.json(await providerStatus({ refresh: query.data.refresh === '1' }));
      },
    )

    .put(
      '/providers/:provider/enabled',
      paramZodValidator(z.object({ provider: providerParamSchema }), { message: 'provider and enabled boolean are required' }),
      jsonZodValidator(providerEnabledSchema, { message: 'provider and enabled boolean are required' }),
      async (c) => {
        const provider = { data: c.req.valid('param').provider };
        const body = { data: c.req.valid('json') };
        let workspace: WorkspaceConfig;
        try {
          workspace = await workspaceConfig.mergeWrite((config) => {
            const disabled = new Set(config.disabledProviders);
            if (body.data.enabled) disabled.delete(provider.data);
            else disabled.add(provider.data);
            config.disabledProviders = PROVIDER_IDS.filter((id) => disabled.has(id));
          });
        } catch {
          return c.json({ error: 'Provider preference could not be saved.' }, 500);
        }
        const result = applyProviderEnablement(
          await providerAuth.status(),
          workspace.disabledProviders,
        );
        const row = result.providers.find(({ provider: id }) => id === provider.data);
        if (row) workspaceEvents.emit('provider-status', row);
        return c.json(result);
      },
    )

    .post(
      '/providers/:provider/retry',
      paramZodValidator(z.object({ provider: providerParamSchema }), { message: 'provider and current authFailureId are required' }),
      jsonZodValidator(providerRetrySchema, { message: 'provider and current authFailureId are required' }),
      async (c) => {
        const provider = { data: c.req.valid('param').provider };
        const body = { data: c.req.valid('json') };
        if (!providerAuth.clearRuntimeAuthFailure(provider.data, body.data.authFailureId)) {
          return c.json({ error: 'Authentication incident changed. Refresh and try again.' }, 409);
        }
        const result = await providerStatus({ refresh: true });
        const row = result.providers.find(({ provider: id }) => id === provider.data);
        if (row) workspaceEvents.emit('provider-status', row);
        return c.json(result);
      },
    )

    .post('/providers/connect', jsonZodValidator(providerConnectSchema, { message: 'provider must be claude, codex, or opencode' }), async (c) => {
      const body = { data: c.req.valid('json') };

      const provider = body.data.provider as ProviderId;
      const command = providerAuth.loginCommand(provider);
      const row = (await providerAuth.status({ refresh: true })).providers.find(
        (candidate) => candidate.provider === provider,
      );
      if (!row) {
        return c.json({ error: 'Authentication could not be verified. Try again.' }, 500);
      }

      if (row.status === 'connected') {
        return c.json({ opened: false, connected: true, command });
      }
      if (row.status === 'not-installed') {
        return c.json({ error: row.hint ?? providerAuth.installHint(provider), command }, 409);
      }
      if (row.status === 'unknown') {
        return c.json({ error: row.hint ?? 'Authentication could not be verified. Try again.', command }, 409);
      }
      if (!capabilities().localHandoff) {
        return c.json({ error: 'Run this command on the machine hosting cezar.', command }, 409);
      }
      let opened = false;
      try {
        opened = await openTerminal(bootRoot, command);
      } catch {
        // Terminal handoff is best-effort; the exact command remains the safe fallback.
      }
      if (!opened) {
        return c.json({ error: 'No terminal emulator could be opened. Run this command manually.', command }, 409);
      }
      return c.json({ opened: true, command });
    });

  // ---- workspace projects (multi-project spec) -----------------------------
  // The registered-project list for the cockpit sidebar. Same-origin (unlike
  // health), so absolute `root`s are fine here. `listProjects()` TTL-caches
  // its per-root status/branch probes, so a burst of renders never shells git
  // N times. Never 404s: empty or unreadable registry → `projects: []`.
  /** The configured checkout root, as WRITTEN (`~` kept — callers that touch
   *  the filesystem expand it). An unreadable workspace degrades to the
   *  default rather than failing the request: every caller here is a route
   *  that must keep answering. */
  const workspaceProjectsDir = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig()).projectsDir;
    } catch {
      return defaultWorkspaceConfig().projectsDir;
    }
  };

  const workspaceBrowseRoot = async (): Promise<string> => {
    try {
      return (await loadWorkspaceConfig()).browseRoot;
    } catch {
      return defaultWorkspaceConfig().browseRoot;
    }
  };

  // ---- chained family: project registry (workspace-level) ----
  const projectsRoutes = new Hono<ProjectApiEnv>()
    .get('/projects', async (c) => {
      let projects: ProjectListEntry[] = [];
      let projectsDir = defaultWorkspaceConfig().projectsDir;
      try {
        projectsDir = (await loadWorkspaceConfig()).projectsDir;
        const selector = capabilities().singleProject
          ? { projectId: await resolveBootProject() }
          : undefined;
        projects = await listProjects(selector);
      } catch {
        // unreadable workspace — degrade to the empty registry + defaults
      }
      const body: ProjectsResponse = {
        projects,
        bootProject: await resolveBootProject(projects),
        projectsDir,
      };
      return c.json(body);
    })

    .post('/projects', jsonZodValidator(() => registerProjectSchema, { message: 'root must be a non-empty path' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const registered = await registerFolder(parsed.data.root, 'local');
      if (registered.status !== 200) return c.json(registered.body, registered.status);
      return c.json(registered.body, 200);
    })

    .delete('/projects/:projectId', async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('removing projects'), 409);
      }
      const raw = c.req.param('projectId');
      // Same gate the scoped-route resolver applies, and the same 404 wording —
      // a malformed id is an unknown project, not a validation essay.
      if (!projectIdSchema.safeParse(raw).success) {
        return c.json({ error: `unknown project: ${raw}` }, 404);
      }
      const bootId = await resolveBootProject();
      // `default` is the boot alias everywhere else in the API; honour it here
      // too rather than 404ing a spelling the cockpit is allowed to use.
      const id = raw === 'default' ? bootId : raw;

      let entry: WorkspaceProject | undefined;
      try {
        entry = (await loadWorkspaceConfig()).projects.find((p) => p.id === id);
      } catch {
        // unreadable workspace — there is nothing to remove, and saying so is
        // more useful than a 500 the user cannot act on
      }
      if (!entry) return c.json({ error: `unknown project: ${id}` }, 404);

      // The boot project is refused, not removed: `cezar serve` re-registers the
      // repo it was started in on every boot, so "removing" it would undo itself
      // at the next restart while breaking this session's sidebar in the
      // meantime. The pane disables the button and says the same thing.
      if (id === bootId) {
        return c.json(
          {
            error: `cezar is serving ${entry.name} right now — it re-registers itself at every start, so it cannot be removed from here`,
          },
          409,
        );
      }

      const active = activeRunCount(id);
      if (active > 0) {
        return c.json(
          {
            error: `${entry.name} has ${active} running task${active === 1 ? '' : 's'} — cancel or finish ${active === 1 ? 'it' : 'them'} before removing the project`,
            runningTasks: active,
          },
          409,
        );
      }

      let removed: boolean;
      try {
        removed = await removeProject(id);
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // Lost a race with another writer (or another cezar process): the entry is
      // gone, which is what the caller wanted, but say it honestly.
      if (!removed) return c.json({ error: `unknown project: ${id}` }, 404);
      // In-process handles for a project no route can reach any more: store
      // closed (index flushed), manager's timers and usage subscription dropped.
      contexts.dispose(id);
      workspaceEvents.emit('project-removed', { id });
      const body: RemoveProjectResponse = { removed: true, id };
      return c.json(body);
    })

    .patch('/projects/:projectId', jsonZodValidator(() => updateProjectSchema), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('editing projects'), 409);
      }
      const raw = c.req.param('projectId');
      // Same gate + 404 wording as DELETE: a malformed id is an unknown project.
      if (!projectIdSchema.safeParse(raw).success) {
        return c.json({ error: `unknown project: ${raw}` }, 404);
      }
      const parsed = { data: c.req.valid('json') };
      // `default` is the boot alias the cockpit is allowed to use everywhere else.
      const id = raw === 'default' ? await resolveBootProject() : raw;
      const { maxParallel } = parsed.data;

      // Read-first (mirroring DELETE, server.ts:1252-1258): a well-formed but
      // unknown id must 404 WITHOUT rewriting the config — otherwise it would both
      // do a needless full-config tmp+rename and, on a read-only home, surface the
      // write failure as a 500 where the honest answer is 404.
      let known = false;
      try {
        known = (await loadWorkspaceConfig()).projects.some((p) => p.id === id);
      } catch {
        // unreadable workspace — treat as unknown; the read-only case answers 404,
        // not a 500 the caller cannot act on (same reasoning as DELETE).
      }
      if (!known) return c.json({ error: `unknown project: ${id}` }, 404);

      let updated: WorkspaceProject | undefined;
      try {
        await mergeWriteWorkspaceConfig((config) => {
          const entry = config.projects.find((p) => p.id === id);
          if (!entry) return; // lost a race with a concurrent remove — answered below
          // null clears the override; a number sets it. Mutated in place so
          // `.passthrough()` keys on the entry survive.
          if (maxParallel === null) delete entry.maxParallel;
          else entry.maxParallel = maxParallel;
          updated = entry;
        });
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // Raced with a concurrent removal between the read and the write.
      if (!updated) return c.json({ error: `unknown project: ${id}` }, 404);

      // The new ceiling takes effect WITHOUT a restart: refresh the shared
      // semaphore's snapshot and pump every manager — the same live-apply hook
      // `PUT /api/workspace/config` fires for a workspace-cap change.
      await deps.semaphore?.refresh();
      const body: UpdateProjectResponse = {
        project: { ...updated, ...(await probeProjectStatus(updated.root)) },
      };
      return c.json(body);
    })

    .post('/projects/checkout', jsonZodValidator(() => checkoutSchema, { message: 'url must be a GitHub repository' }), async (c) => {
      if (capabilities().singleProject) {
        return c.json(singleProjectRefusal('adding projects'), 409);
      }
      const parsed = { data: c.req.valid('json') };
      const { url, name, checkoutId } = parsed.data;
      const result = await checkoutRepo({
        url,
        name,
        checkoutId,
        projectsDir: expandTilde(await workspaceProjectsDir()),
        onProgress: (event) => workspaceEvents.emit('checkout-progress', event),
        // A closed dialog / navigated-away tab aborts the request; the clone is
        // killed and its partial directory removed rather than left running.
        signal: c.req.raw.signal,
        ...(deps.cloneRunner ? { run: deps.cloneRunner } : {}),
      });
      if (!result.ok) {
        // `reason` rides along on the 503 (`gh` unavailable) — the spec's
        // `{ error, reason }` degradation, mirroring the GitHub pane.
        return c.json(
          'reason' in result ? { error: result.error, reason: result.reason } : { error: result.error },
          result.status,
        );
      }
      const registered = await registerFolder(result.target, 'checkout');
      if (registered.status !== 200) {
        // The clone SUCCEEDED and its files are legitimately the user's, so this
        // path deliberately does NOT clean up — an unregisterable checkout is a
        // registry problem, not a reason to delete a repo we just fetched. Say
        // where it is so they can register it by hand.
        const { body } = registered;
        const error = 'error' in body && body.error ? body.error : 'could not register the checkout';
        return c.json({ error: `${error} (the clone is at ${result.target})` }, registered.status);
      }
      return c.json(registered.body, 200);
    });

  // Register an existing folder (multi-project spec, "Add project" — the
  // folder-browser dialog's commit step, step 4.2). Workspace-level like its
  // GET twin. Everything here is a guard; the registry write itself is one
  // idempotent `registerProject` call.
  const registerProjectSchema = z.object({
    root: z.string().trim().min(1).max(4096),
  });

  /**
   * The register-a-folder half of `POST /api/projects`, factored out so the
   * checkout route (step 4.3) commits its fresh clone through the SAME guards
   * and the same `project-added` emission rather than a second copy of them.
   * Returns the status + body for the caller to answer with.
   */
  const registerFolder = async (
    spelled: string,
    source: 'local' | 'checkout',
  ): Promise<
    // Discriminated on `status`, not one object with a union `body`: a flat
    // `{ status: 200 | 400 | 409 | 500; body: RegisterProjectResponse | { error } }` made
    // `c.json(body, status)` type the route's 200 as carrying the ERROR bodies too, which is a
    // shape neither POST route can answer with (`contract-parity.workspace.test.ts` pins it).
    // Split here so the success branch narrows at the call site instead.
    | { status: 200; body: RegisterProjectResponse }
    | { status: 400 | 409 | 500; body: RegisterProjectResponse | { error: string } }
  > => {
    if (capabilities().singleProject) {
      return { status: 409, body: singleProjectRefusal('adding projects') };
    }
    // `~` is expanded for the same reason `/api/fs/browse` expands it: the
    // dialog hands back absolute paths, but a hand-written body (curl, a
    // future CLI) spells home the way a shell does.
    const requested = expandTilde(spelled);
    if (!requested.startsWith('/')) {
      return {
        status: 400,
        body: { error: `not a folder: ${spelled} is not an absolute path` },
      };
    }
    // Hosted mode: the same root the picker is narrowed to, re-checked — see
    // `isInsideBrowseRoot`. Local mode deliberately has NO containment: a
    // project under `/srv/code` is a normal local setup and `cezar serve`
    // registers it today.
    //
    // Containment is asked in two halves, around the stat, and the split is
    // deliberate.
    //
    // The LEXICAL half runs BEFORE the stat, and that order is the security
    // property: an out-of-root path must answer the SAME way whether or not it
    // exists, or the route becomes the existence oracle fs-browse narrows the
    // tree to prevent. Lexical, not realpath, because a realpath check answers
    // `false` for a path that IS inside the root and merely absent — which
    // would tell a hosted user who typo'd a folder under their own checkout
    // root that it is "outside the browsable root".
    const hostedBrowseRoot = capabilities().localHandoff
      ? null
      : resolveBrowseRoot(await workspaceBrowseRoot());
    if (hostedBrowseRoot !== null) {
      if (!(await isLexicallyInsideBrowseRoot(hostedBrowseRoot, requested))) {
        // No resolved path in the message (fs-browse's rule): saying where the
        // root is would hand a remote viewer the layout the narrowing hides.
        return {
          status: 400,
          body: { error: 'folder is outside the browsable root' },
        };
      }
    }
    // Existence is checked HERE rather than left to `registerProject` (which
    // degrades a failed realpath to a plain resolve): a registry full of
    // `missing` rows the user never had is worse than a 400 they can act on.
    const info = await stat(requested).catch(() => null);
    if (!info?.isDirectory()) return { status: 400, body: { error: `no such folder: ${spelled}` } };
    // The REALPATH half, now that the path is known to exist: a symlink inside
    // the root pointing out of it spells as contained and is not. Same message
    // as the lexical rejection, so the two halves stay indistinguishable from
    // outside.
    if (hostedBrowseRoot !== null && !(await isInsideBrowseRoot(hostedBrowseRoot, requested))) {
      return {
        status: 400,
        body: { error: 'folder is outside the browsable root' },
      };
    }
    // The boot-time auto-registration guard, applied to the manual gesture
    // too: `$HOME` and cezar's own task worktrees are exactly as wrong a
    // project root when a human clicks "Add project" as when `cezar serve`
    // would have registered them. Reachable from the dialog, which starts at
    // `~` and can add the folder it is showing.
    if (!(await shouldRegisterProject(requested))) {
      return {
        status: 400,
        body: {
          error: `not a project folder: ${spelled} is your home directory or a cezar task worktree`,
        },
      };
    }
    // Asked BEFORE the write, because `registerProject` is idempotent and
    // cannot tell us afterwards whether it appended or just bumped
    // `lastOpenedAt`. Same realpath key the registry dedupes on.
    const real = await realpath(requested).catch(() => requested);
    let known = false;
    try {
      known = (await loadWorkspaceConfig()).projects.some((p) => p.root === real);
    } catch {
      // unreadable workspace — treat as unknown; the write below will fail loudly
    }
    let project: ProjectListEntry;
    try {
      const entry = await registerProject(requested, source);
      project = { ...entry, ...(await probeProjectStatus(entry.root)) };
    } catch (err) {
      // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
      return {
        status: 500,
        body: { error: err instanceof Error ? err.message : String(err) },
      };
    }
    if (known) {
      // 409 with the EXISTING entry (spec): the dialog treats it as "you
      // already have this one" and navigates there rather than dead-ending.
      return {
        status: 409,
        body: { project, error: `already registered as ${project.id}` },
      };
    }
    // Only a genuinely new project is an event — a re-add is a no-op for every
    // open cockpit's sidebar.
    workspaceEvents.emit('project-added', { project });
    return { status: 200, body: { project } };
  };

  // Deregister a project (multi-project spec, step 4.4 — Settings → Projects,
  // the per-row "Remove"). READ THIS BEFORE TOUCHING THE HANDLER: the ONLY
  // durable effect allowed here is dropping one entry from
  // `~/.cezar/config.json`. There is deliberately no `rm`, no `rmdir`, no
  // `RunStore.open` (which would `mkdir` `<root>/.ai/cezar/runs` and therefore
  // WRITE into a folder the user just asked us to forget) anywhere below —
  // `removeProject` is a registry filter and `contexts.dispose` only tears down
  // in-process handles. Re-registering the same root later finds every task,
  // worktree and transcript exactly where it was. The confirmation copy in the
  // cockpit promises precisely this; the promise is kept here.
  //
  // A run this server is responsible for blocks the removal with a 409 (spec):
  // deregistering mid-run would strand a live agent process under a root no
  // route can resolve any more — the run would keep burning tokens with no
  // cockpit able to show, message or cancel it.
  const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['queued', 'running', 'waiting']);

  /**
   * How many of `projectId`'s runs this process is actively responsible for.
   *
   * Counted from the ALREADY-BUILT context only (`peek`, never `context()`):
   * a project with no context in this process has no manager, therefore no
   * agent to strand — and building one to answer the question would recover
   * and resume runs on a project being deleted, which is the exact opposite of
   * what the caller asked for. Reading the run index off disk instead was
   * rejected for the same reason as the `rm` above: `RunStore.open` creates
   * directories, and a stale `running` row left by a crashed process would
   * become a 409 the user could never clear.
   */
  const activeRunCount = (projectId: string): number => {
    const ctx = contexts.peek(projectId);
    if (!ctx) return 0;
    return ctx.store.listRuns().filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
  };

  // Workspace-level by design: update state spans project and global installs,
  // but the selected registered project supplies the safe, server-owned cwd.
  const skillsUpdateInputSchema = z.object({ projectId: projectIdSchema }).strict();
  const resolveSkillsUpdateRoot = async (raw: string): Promise<
    { root: string } | { status: 404 | 409; error: string }
  > => {
    if (!projectIdSchema.safeParse(raw).success) return { status: 404, error: `unknown project: ${raw}` };
    const bootId = await resolveBootProject();
    if (raw === 'default' || raw === bootId) return { root: bootRoot };
    const project = (await loadWorkspaceConfig()).projects.find((entry) => entry.id === raw);
    if (!project) return { status: 404, error: `unknown project: ${raw}` };
    if ((await probeProjectStatus(project.root)).status === 'missing') {
      return { status: 409, error: `project folder not found: ${raw}` };
    }
    return { root: project.root };
  };

  const skillsUpdateResponse = async (state: SkillsUpdateState): Promise<SkillsUpdateState> => {
    const config = await loadWorkspaceConfig();
    return { ...state, autoUpdateEnabled: effectiveSkillsAutoUpdate(config), inherited: config.skillsAutoUpdate === undefined };
  };

  // ---- chained family: skills updates (workspace-level) ----
  const skillsUpdateRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/skills-update', queryZodValidator(skillsUpdateInputSchema, { message: 'projectId is required' }), async (c) => {
      const parsed = { data: c.req.valid('query') };
      const resolved = await resolveSkillsUpdateRoot(parsed.data.projectId);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      const state: SkillsUpdateState = skillsUpdate.snapshot(resolved.root);
      void skillsUpdate.check(resolved.root).catch(() => {});
      return c.json(await skillsUpdateResponse(state));
    })

    .post('/workspace/skills-update/check', jsonZodValidator(skillsUpdateInputSchema, { message: 'body must contain only projectId' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const resolved = await resolveSkillsUpdateRoot(parsed.data.projectId);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      return c.json(await skillsUpdateResponse(await skillsUpdate.check(resolved.root, true)));
    })

    .post('/workspace/skills-update/apply', jsonZodValidator(skillsUpdateInputSchema, { message: 'body must contain only projectId' }), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const resolved = await resolveSkillsUpdateRoot(parsed.data.projectId);
      if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
      try {
        return c.json(await skillsUpdateResponse(await skillsUpdate.update(resolved.root, true)));
      } catch (error) {
        if (error instanceof SkillsUpdateConflictError) {
          return c.json({ error: 'another skills update operation is running', state: await skillsUpdateResponse(skillsUpdate.snapshot(resolved.root)) }, 409);
        }
        throw error;
      }
    });

  // Edit one field of an existing registry entry (spec
  // 2026-07-22-per-project-concurrency): the per-project concurrency ceiling.
  // A PATCH (not PUT) because it touches a single field, and a distinct route
  // from POST (register-a-folder) to keep register vs. edit semantics clear.
  // `maxParallel: null` clears the override back to "inherit the workspace
  // cap". Bounds mirror `workspaceProjectSchema` (config.ts) exactly, so a
  // value this route accepts can never be degraded away by the next load's
  // `.catch`.
  const updateProjectSchema = z.object({
    maxParallel: z.number().int().min(1).max(16).nullable(),
  });
  // ---- GUI clone (multi-project spec, step 4.3) ----------------------------
  // "Add project → Clone from GitHub": clone into the checkout root, then
  // register the result through `registerFolder` above (same guards, same
  // `project-added`). Everything dangerous — where the clone may land, and
  // what a failed clone is allowed to delete — lives in src/server/checkout.ts.
  //
  // Long-running by design (the spec's contract): the response lands when the
  // clone finishes, and the dialog's liveness comes from `checkout-progress`
  // events on the workspace stream. `checkoutId` is the cockpit's own
  // correlation token, echoed on every event so two tabs cloning at once never
  // render each other's progress.
  const checkoutSchema = z.object({
    url: z.string().trim().min(1).max(512),
    name: z.string().trim().max(128).optional(),
    checkoutId: z.string().trim().max(128).optional(),
  });
  // ---- workspace settings (multi-project spec, step 2.7) -------------------
  // WORKSPACE-level routes: single-mount (never mirrored under /api/p/),
  // same-origin. The config routes carry the settings UI's slice of
  // `~/.cezar/config.json` — global knobs only; the registry stays on
  // /api/projects above, and schemaVersion (a migration cursor, not a
  // setting) is deliberately omitted.
  const workspaceConfigBody = (config: WorkspaceConfig): WorkspaceConfigResponse => ({
    browseRoot: config.browseRoot,
    projectsDir: config.projectsDir,
    skillsAutoUpdate: config.skillsAutoUpdate ?? null,
    effectiveSkillsAutoUpdate: effectiveSkillsAutoUpdate(config),
    composerDefaults: {
      autonomous: config.composerDefaults.autonomous ?? null,
      worktree: config.composerDefaults.worktree ?? null,
      inheritedAutonomous:
        process.env.CEZ_AUTONOMOUS_DEFAULT === '0'
          ? false
          : process.env.CEZ_AUTONOMOUS_DEFAULT === '1'
            ? true
            : 'source-dependent',
      inheritedWorktree: effectiveComposerDefault(
        undefined,
        process.env.CEZ_WORKTREE_DEFAULT,
        true,
      ),
    },
    resources: {
      maxParallel: config.resources.maxParallel,
      maxMonitoringSessions: config.resources.maxMonitoringSessions,
      monitoringWakeIntervalMinutes: config.resources.monitoringWakeIntervalMinutes,
      memoryLimitMb: config.resources.memoryLimitMb,
      worktreeRetentionDefault: config.resources.worktreeRetentionDefault,
    },
  });
  // ---- chained family: workspace settings + GUI prefs (workspace-level) ----
  const workspaceConfigRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/config', async (c) => c.json(workspaceConfigBody(await loadWorkspaceConfig())))

    .put('/workspace/config', jsonZodValidator(() => workspaceConfigUpdateSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      const { browseRoot, projectsDir, skillsAutoUpdate, composerDefaults, resources } = parsed.data;
      for (const [configuredRoot, create] of [
        [browseRoot, false],
        [projectsDir, true],
      ] as const) {
        if (configuredRoot === undefined) continue;
        // Validated ON CHANGE, never at load (spec): browse roots must already
        // exist; checkout roots use `mkdir -p`. Both get a real write probe.
        // Any failure → 400 and NO change persisted.
        const expanded = expandTilde(configuredRoot);
        if (!expanded.startsWith('/')) {
          return c.json({ error: `not writable: ${configuredRoot} is not an absolute path` }, 400);
        }
        if (!create) {
          try {
            if (!(await stat(expanded)).isDirectory()) {
              return c.json({ error: `browse folder is not a directory: ${configuredRoot}` }, 400);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              return c.json({ error: `browse folder does not exist: ${configuredRoot}` }, 400);
            }
            return c.json({ error: `browse folder unavailable: ${err instanceof Error ? err.message : String(err)}` }, 400);
          }
        }
        const probeError = await probeWritableDir(expanded, create);
        if (probeError !== null) return c.json({ error: `not writable: ${probeError}` }, 400);
      }
      let written: WorkspaceConfig;
      try {
        written = await mergeWriteWorkspaceConfig((config) => {
          // Roots are stored as written (`~` kept); only the probe expands them.
          if (browseRoot !== undefined) config.browseRoot = browseRoot;
          if (projectsDir !== undefined) config.projectsDir = projectsDir;
          if (skillsAutoUpdate === null) delete config.skillsAutoUpdate;
          else if (skillsAutoUpdate !== undefined) config.skillsAutoUpdate = skillsAutoUpdate;
          if (composerDefaults?.autonomous === null) delete config.composerDefaults.autonomous;
          else if (composerDefaults?.autonomous !== undefined) {
            config.composerDefaults.autonomous = composerDefaults.autonomous;
          }
          if (composerDefaults?.worktree === null) delete config.composerDefaults.worktree;
          else if (composerDefaults?.worktree !== undefined) {
            config.composerDefaults.worktree = composerDefaults.worktree;
          }
          if (resources?.maxParallel !== undefined) config.resources.maxParallel = resources.maxParallel;
          if (resources?.maxMonitoringSessions !== undefined) {
            config.resources.maxMonitoringSessions = resources.maxMonitoringSessions;
          }
          if (resources?.monitoringWakeIntervalMinutes !== undefined) {
            config.resources.monitoringWakeIntervalMinutes = resources.monitoringWakeIntervalMinutes;
          }
          if (resources?.memoryLimitMb !== undefined) config.resources.memoryLimitMb = resources.memoryLimitMb;
          if (resources?.worktreeRetentionDefault !== undefined) {
            config.resources.worktreeRetentionDefault = resources.worktreeRetentionDefault;
          }
        });
      } catch (err) {
        // e.g. a read-only home — nothing was persisted (atomic tmp+rename).
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // A resource change takes effect WITHOUT a restart: refresh the shared
      // semaphore's in-memory snapshot and pump every manager (step 2.5's hook).
      if (resources !== undefined) await deps.semaphore?.refresh();
      return c.json(workspaceConfigBody(written));
    })

    // Global GUI state (`~/.cezar/ui-state.json`) — same parse/key-cap/shallow-
    // merge semantics as the per-repo /api/v1/ui-state route below (the shared half
    // is `uiStateBodySchema`), but backed by the workspace file.
    .get('/workspace/ui-state', async (c) => c.json(await readWorkspaceUiState()))

    // The tighter body cap rides on `use` rather than inline on the route: `bodyLimit` is typed
    // as a bare MiddlewareHandler, and passing one to `.put()` collapses the route's schema, so
    // the PUT went missing from `AppType` and `hc` could not see its body at all. `use` runs at
    // the same point (before the handler, so the cap still precedes any read) and leaves the
    // chain's type accumulation alone. Method-agnostic here, which the GET does not mind.
    .use('/workspace/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))

    .put('/workspace/ui-state', jsonZodValidator(workspaceUiStateBody), async (c) => {
      const parsed = { data: c.req.valid('json') };
      try {
        return c.json(
          await mergeWriteWorkspaceUiState((state) => ({
            ...state,
            ...parsed.data,
          })),
        );
      } catch (err) {
        // A read-only home degrades to an unsaved pref, never a crash.
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    });

  // Partial updates only — absent keys stay untouched. Bounds mirror the
  // workspace schema (src/workspace/config.ts, step 1.2) exactly, so a value
  // this route accepts can never be degraded away by the next load's `.catch`.
  const workspaceConfigUpdateSchema = z.object({
    browseRoot: z.string().trim().min(1).max(4096).optional(),
    projectsDir: z.string().trim().min(1).max(4096).optional(),
    skillsAutoUpdate: z.boolean().nullable().optional(),
    composerDefaults: z
      .object({
        autonomous: z.boolean().nullable().optional(),
        worktree: z.boolean().nullable().optional(),
      })
      .optional(),
    resources: z
      .object({
        maxParallel: z.number().int().min(1).max(16).optional(),
        maxMonitoringSessions: z.number().int().min(0).max(16).optional(),
        monitoringWakeIntervalMinutes: z.number().int().min(1).max(60).nullable().optional(),
        memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
        worktreeRetentionDefault: z.number().int().min(0).max(1000).optional(),
      })
      .optional(),
  });
  // ---- chained family: filesystem browse (workspace-level) ----
  const fsBrowseRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/fs/browse',
      queryZodValidator(z.object({ path: queryValue, showHidden: queryValue })),
      async (c) => {
        if (capabilities().singleProject) {
          return c.json(singleProjectRefusal('folder browsing'), 409);
        }
        const query = c.req.valid('query');
        const root = resolveBrowseRoot(await workspaceBrowseRoot());
        const result = await browseDirectory({
          root,
          path: query.path,
          showHidden: query.showHidden === '1',
        });
        if (!result.ok) return c.json({ error: result.error }, result.status);
        return c.json(result.body);
      },
    );

  // ---- chained family: launch-key (project-scoped) ----
  const launchKeyRoutes = new Hono<ProjectApiEnv>()
    .get('/launch-key', (c) => c.json({ key: c.get('project').launchKey }));

  // ---- chained family: skills (project-scoped) ----
  const skillsRoutes = new Hono<ProjectApiEnv>()
    .get('/skills', queryZodValidator(waitQuery), async (c) => {
      const repoRoot = c.get('project').root;
      // The default read stays fast and starts the team load in the background.
      // The cockpit follows it with `wait=1`, off the render path, so a cold
      // cache converges without polling or a manual reload (spec 005 / #555).
      if (c.req.valid('query').wait === '1') await waitForTeamSkills(repoRoot);
      return c.json(await discoverSkills(repoRoot));
    })

    // The opt-in catalog for the "Import skills" panel: every skill a default
    // (vendor) repo offers — `open-mercato/skills` — regardless of import state,
    // so the panel can present them all with a per-skill toggle. Empty once a repo
    // configures its own `skillsRepos` (nothing is gated then). `wait=1` lets the
    // panel wait out a cold team-skill cache, same as `GET /skills` (spec 005).
    .get('/skills/importable', queryZodValidator(waitQuery), async (c) => {
      const repoRoot = c.get('project').root;
      const gated = await gatedSkillsRepos(repoRoot);
      if (gated.size === 0) return c.json([]);
      if (c.req.valid('query').wait === '1') await waitForTeamSkills(repoRoot);
      const importable = getTeamSkillsCached(repoRoot)
        .filter((skill) => skill.team && gated.has(skill.team.repo))
        // Spread `description` rather than writing it unconditionally: an undefined VALUE is
        // dropped by JSON.stringify, so the key is absent on the wire, and writing it always
        // typed the route as sending a key it does not. contract/skills.ts says `.optional()`,
        // which is what the client actually receives.
        .map((skill) => ({
          name: skill.name,
          ...(skill.description !== undefined ? { description: skill.description } : {}),
        }));
      return c.json(importable);
    })

    // Refresh team skills (spec 005): clone/fetch the configured skills repos,
    // then return the merged catalog. Degrades quietly — offline just means the
    // team entries stay as they were (or absent).
    .post('/skills/refresh', async (c) => {
      const { root: repoRoot } = c.get('project');
      await refreshTeamSkills(repoRoot);
      return c.json(await discoverSkills(repoRoot));
    });

  // ---- chained family: GUI prefs / ui-state (project-scoped) ----
  const uiStateRoutes = new Hono<ProjectApiEnv>()
    .get('/ui-state', async (c) => c.json(await readUiState(c.get('project').root)))

    // On `use`, not inline on the route — see the workspace ui-state PUT above.
    .use('/ui-state', bodyLimit({ maxSize: UI_STATE_BODY_LIMIT }))

    .put('/ui-state', jsonZodValidator(uiStateBody), async (c) => {
      const { root: repoRoot, dataDir } = c.get('project');
      // `.passthrough()` keeps unknown prefs (BACKWARD_COMPATIBILITY §3), but a
      // single request may not stuff an unbounded key set (#429) — the shared
      // schema+cap half of both ui-state routes lives in `uiStateBody`.
      const parsed = { data: c.req.valid('json') };
      const merged = { ...(await readUiState(repoRoot)), ...parsed.data };
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(uiStatePath(repoRoot), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return c.json(merged);
    });

  // ---- chained family: workflows (project-scoped) --------------------------
  // One chained expression, mounted by `createApp` into BOTH the legacy `api`
  // table and the versioned `v1` one — see `healthRoutes` for why the chain
  // shape (not the statement shape) is what carries the types.
  const workflowsRoutes = new Hono<ProjectApiEnv>()
    .get('/workflows', async (c) => c.json(await loadWorkflows(c.get('project').root)))

    // Save an approved plan as a reusable chain (spec 008): YAML in
    // `.ai/cezar/workflows/<slug>.yaml` — from then on it's in the dropdown
    // like any other workflow.
    .post('/workflows', jsonZodValidator(saveWorkflowSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const steps = parsed.data.steps ?? skillsToSteps(parsed.data.skills ?? []);
      const issue = stepsIssue(steps);
      if (issue) return c.json({ error: issue }, 400);
      const slug = slugify(parsed.data.name) || 'chain';
      const dir = join(repoRoot, WORKFLOWS_DIR);
      const path = join(dir, `${slug}.yaml`);
      // Pure skill stacks are written in the portable compact form (spec 012) —
      // `name` + `skills:` — so the file imports cleanly in any repo.
      const stack = skillStackOf(steps);
      const doc = {
        name: parsed.data.name,
        ...(parsed.data.description ? { description: parsed.data.description } : {}),
        ...(stack ? { skills: stack } : { steps }),
      };
      try {
        await mkdir(dir, { recursive: true });
        // `wx` = fail if the file exists — no silent overwrite of a chain.
        await writeFile(path, stringifyYaml(doc), {
          encoding: 'utf8',
          flag: parsed.data.overwrite ? 'w' : 'wx',
        });
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
          return c.json({ error: `workflow file already exists: ${path}`, exists: true }, 409);
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 500);
      }
      return c.json({ path, name: parsed.data.name }, 201);
    })

    // Delete a saved workflow (spec 012 follow-up): file workflows only —
    // built-ins have no file and always come back.
    .delete('/workflows/:name', async (c) => {
      const { root: repoRoot } = c.get('project');
      const name = c.req.param('name');
      const { workflows } = await loadWorkflows(repoRoot);
      const wf = workflows.find((w) => w.name === name);
      if (!wf) return c.json({ error: `unknown workflow: ${name}` }, 404);
      if (wf.source !== 'file' || !wf.path) {
        return c.json({ error: 'built-in workflows cannot be deleted' }, 400);
      }
      const dir = resolve(repoRoot, WORKFLOWS_DIR);
      const target = resolve(wf.path);
      if (!target.startsWith(dir + sep)) {
        return c.json({ error: 'refusing to delete a file outside the workflows dir' }, 400);
      }
      try {
        await unlink(target);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      return c.json({ ok: true, path: target });
    })

    // Import support for the builder (spec 012): parse + validate a pasted
    // workflow YAML (either form) and hand back the normalized definition. The
    // server owns YAML parsing — the GUI stays dependency-free.
    .post('/workflows/parse', jsonZodValidator(parseWorkflowSchema), async (c) => {
      const parsed = { data: c.req.valid('json') };
      let raw: unknown;
      try {
        raw = parseYaml(parsed.data.yaml);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `not valid YAML: ${message}` }, 400);
      }
      const doc = workflowFileSchema.safeParse(raw);
      if (!doc.success) {
        return c.json({ error: doc.error.issues.map((i) => i.message).join('; ') }, 400);
      }
      const normalized = normalizeWorkflowDoc(doc.data);
      const issue = stepsIssue(normalized.steps);
      if (issue) return c.json({ error: issue }, 400);
      return c.json(normalized);
    });

  // ---- chained family: plan (project-scoped) ----
  const planRoutes = new Hono<ProjectApiEnv>()
    .post('/plan', jsonZodValidator(planSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const blocked = await providerActionError([(await loadConfig(repoRoot)).defaultRunner]);
      if (blocked) return c.json({ error: blocked }, 409);
      return c.json(await planChain(repoRoot, parsed.data.task));
    });

  // ---- GitHub automations --------------------------------------------------

  /**
   * One manual "test filter" check, in server memory only.
   *
   * Declared here rather than inferred from `contract/src/automations.ts`: the contract's
   * `automationCheckSchema` is checked against what this route ANSWERS
   * (`contract-parity.automations.test.ts`), and a schema that annotated the handler it is
   * compared with would be true by construction.
   */
  type ManualCheck = {
    id: string;
    automationId: string;
    mode: 'preview' | 'execute';
    status: 'queued' | 'running' | 'complete' | 'error';
    createdAt: string;
    completedAt?: string;
    matches?: number;
    truncated?: boolean;
    error?: string;
  };
  const manualChecks = new Map<string, ManualCheck>();

  // ---- chained family: GitHub automations (project-scoped) ----
  // Every handler below reads `c.get('project')` — the definitions, their runtime state and the
  // execution log are per-project files — so the family is project-scoped and mounted with the
  // rest of the mirrored table. The one exception is the manual-check read, which touches no
  // project at all; it is its own workspace-level family below.
  const automationsRoutes = new Hono<ProjectApiEnv>()
    .get('/automations', async (c) => {
      const { root, automationStore } = c.get('project');
      const forge = resolveForge(await getRepoInfo(root));
      // Annotated, so the two branches are ONE shape rather than a union of two: the fallback
      // literal always carries `reason`, the cached answer only sometimes does, and the route
      // type is what `contract/src/automations.ts` has to describe.
      const availability: ForgeAvailability = forge?.detectCached() ?? {
        available: false,
        reason: forge ? 'GitHub availability is still being checked' : 'No GitHub remote is configured',
      };
      const automations = automationStore.list().map((automation) => {
        const logs = automationStore.logs({ automationId: automation.id, limit: 100 });
        const state = automationStore.state(automation.id);
        const latestLog = logs[0];
        return {
          ...automation,
          // Spread conditionally, never `state: maybeUndefined`: the latter types the key as
          // always-present while `JSON.stringify` drops it from the wire, so the contract would
          // have to describe a key consumers never receive.
          ...(state ? { state } : {}),
          ...(latestLog ? { latestLog } : {}),
          counts: {
            matches: logs.filter((row) => row.result === 'launched' || row.result === 'duplicate').length,
            launched: logs.filter((row) => row.result === 'launched').length,
            duplicates: logs.filter((row) => row.result === 'duplicate').length,
            errors: logs.filter((row) => row.result === 'error' || row.result === 'rate-limited').length,
          },
        };
      });
      const nextDue = automations.map((item) => item.state?.nextCheckAt).filter(Boolean).sort()[0];
      return c.json({
        ...availability,
        scheduler: {
          // `as const` on both arms: in an object literal a conditional of two string literals
          // widens to `string`, which would erase the two states this key can hold.
          state: automations.some((item) => item.enabled) ? ('scheduled' as const) : ('idle' as const),
          ...(nextDue ? { nextDue } : {}),
        },
        automations,
      });
    })

    .post('/automations', jsonZodValidator(() => automationCreateSchema), async (c) => {
      const { automationStore } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const promptIssue = validateAutomationPrompt(parsed.data.task.prompt);
      if (promptIssue) return c.json({ error: promptIssue }, 400);
      const { enable, ...input } = parsed.data;
      try {
        const automation = automationStore.create({ ...input, enabled: enable === true });
        if (enable) {
          const baselineAt = new Date().toISOString();
          automationStore.setState(automation.id, {
            revision: automation.revision,
            baselineAt,
            cursor: { timestamp: baselineAt },
            nextCheckAt: new Date(Date.now() + automation.intervalSeconds * 1_000).toISOString(),
          });
        }
        emitAutomationChange(c.get('project'), automation.id, automation.revision);
        automationsChanged();
        return c.json({ automation }, 201);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    })

    .get('/automations/:id', (c) => {
      const { automationStore } = c.get('project');
      const automation = automationStore.get(c.req.param('id'));
      if (!automation) return c.json({ error: 'not found' }, 404);
      const state = automationStore.state(automation.id);
      const latestLog = automationStore.logs({ automationId: automation.id, limit: 1 })[0];
      return c.json({
        automation,
        ...(state ? { state } : {}),
        ...(latestLog ? { latestLog } : {}),
      });
    })

    .put('/automations/:id', jsonZodValidator(() => automationUpdateSchema), async (c) => {
      const { automationStore } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const promptIssue = validateAutomationPrompt(parsed.data.task.prompt);
      if (promptIssue) return c.json({ error: promptIssue }, 400);
      const { expectedRevision, ...input } = parsed.data;
      if (!automationStore.get(c.req.param('id'))) return c.json({ error: 'not found' }, 404);
      try {
        const automation = automationStore.update(c.req.param('id'), expectedRevision, { ...input, enabled: input.enabled ?? false });
        emitAutomationChange(c.get('project'), automation.id, automation.revision);
        automationsChanged();
        return c.json({ automation });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return c.json({ error: message }, message.includes('conflict') ? 409 : 400);
      }
    })

    .delete('/automations/:id', (c) => {
      const id = c.req.param('id');
      const store = c.get('project').automationStore;
      const current = store.get(id);
      if (!current || !store.delete(id)) return c.json({ error: 'not found' }, 404);
      emitAutomationChange(c.get('project'), id, current.revision, true);
      automationsChanged();
      return c.body(null, 204);
    })

    .post('/automations/:id/enable', (c) => {
      const store = c.get('project').automationStore;
      const current = store.get(c.req.param('id'));
      if (!current) return c.json({ error: 'not found' }, 404);
      const automation = store.update(current.id, current.revision, { ...editableAutomation(current), enabled: true });
      const baselineAt = new Date().toISOString();
      store.setState(automation.id, {
        ...store.state(automation.id),
        revision: automation.revision,
        baselineAt,
        cursor: { timestamp: baselineAt },
        nextCheckAt: new Date(Date.now() + automation.intervalSeconds * 1_000).toISOString(),
      });
      store.appendLog({ automationId: automation.id, revision: automation.revision, result: 'baseline', reason: 'Enabled from a current-time baseline; existing records were not launched.' });
      emitAutomationChange(c.get('project'), automation.id, automation.revision);
      automationsChanged();
      return c.json({ automation });
    })

    .post('/automations/:id/pause', (c) => {
      const store = c.get('project').automationStore;
      const current = store.get(c.req.param('id'));
      if (!current) return c.json({ error: 'not found' }, 404);
      const automation = store.update(current.id, current.revision, { ...editableAutomation(current), enabled: false });
      emitAutomationChange(c.get('project'), automation.id, automation.revision);
      automationsChanged();
      return c.json({ automation });
    })

    // The body is validated as MIDDLEWARE, which is what puts it in the route type — and moves
    // the 400 ahead of this route's 404: `POST /automations/<unknown>/check` with a malformed
    // body now answers 400 rather than 404. Nothing else about either answer changed.
    .post('/automations/:id/check', jsonZodValidator(() => automationCheckRequestSchema), async (c) => {
      const project = c.get('project');
      const store = project.automationStore;
      const automation = store.get(c.req.param('id'));
      if (!automation) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // `string`, not `randomUUID`'s template-literal type: the wire carries an opaque id, and
      // leaking `${string}-${string}-…` into the route type would make the contract describe the
      // generator rather than the answer.
      const id: string = randomUUID();
      const check: ManualCheck = { id, automationId: automation.id, mode: parsed.data.mode, status: 'queued', createdAt: new Date().toISOString() };
      if (manualChecks.size >= 200) manualChecks.delete(manualChecks.keys().next().value!);
      manualChecks.set(id, check);
      void (async () => {
        check.status = 'running';
        try {
          const remote = parseRemote((await getRepoInfo(project.root))?.remote ?? '');
          if (!remote || remote.host !== 'github.com') throw new Error('No GitHub remote is configured');
          const scheduler = new ProjectAutomationScheduler({
            projectId: project.id,
            owner: remote.owner,
            repo: remote.repo,
            store,
            poller: new GithubPoller(),
            launch: parsed.data.mode === 'execute'
              ? (definition, candidate, receiptId) => launchAutomationRun({ root: project.root, manager: project.manager, store: project.store, definition, candidate, receiptId })
              : undefined,
            onChange: (automationId, revision) => emitAutomationChange(project, automationId, revision),
          });
          const result = await scheduler.check(automation, parsed.data.mode);
          Object.assign(check, { status: 'complete', completedAt: new Date().toISOString(), matches: result.candidates.length, truncated: result.truncated });
        } catch (error) {
          Object.assign(check, { status: 'error', completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
        }
      })();
      return c.json({ checkId: id }, 202);
    })

    .get('/automation-log', queryZodValidator(automationLogQuerySchema), (c) => {
      return c.json({ records: c.get('project').automationStore.logs(c.req.valid('query')) });
    })

    .post('/automation-log/:receiptId/retry', async (c) => {
      const project = c.get('project');
      const store = project.automationStore;
      const receipt = [...store.latestReceipts().values()].find((row) => row.receiptId === c.req.param('receiptId'));
      if (!receipt) return c.json({ error: 'not found' }, 404);
      if (receipt.status !== 'launch-error' || receipt.runId) return c.json({ error: 'receipt is not retryable' }, 409);
      if (!receipt.candidate) return c.json({ error: 'receipt predates retry context and cannot be retried safely' }, 409);
      const definition = store.get(receipt.automationId);
      if (!definition) return c.json({ error: 'automation not found' }, 404);
      const lease = store.acquireLease();
      if (!lease) return c.json({ error: 'automation polling lease is held by another process' }, 409);
      const reserved = { ...receipt, status: 'reserved' as const, error: undefined, updatedAt: new Date().toISOString() };
      store.appendReceipt(reserved);
      try {
        const launched = await launchAutomationRun({ root: project.root, manager: project.manager, store: project.store, definition, candidate: receipt.candidate, receiptId: receipt.receiptId });
        store.appendReceipt({ ...reserved, status: 'launched', runId: launched.runId, updatedAt: new Date().toISOString() });
        emitAutomationChange(project, definition.id, definition.revision);
        return c.json({ receiptId: receipt.receiptId, runId: launched.runId }, 202);
      } catch (error) {
        store.appendReceipt({ ...reserved, status: 'launch-error', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() });
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      } finally {
        lease.release();
      }
    });

  // ---- chained family: manual automation checks (workspace-level) ----
  // Workspace-level because the handler reads no project: a check lives in the server-memory map
  // above, keyed by an unguessable id that the project-scoped POST hands back. Mounting it under
  // `/api/v1/p/:projectId` too would be a second spelling of a lookup that consults no project.
  const automationChecksRoutes = new Hono()
    .get('/automation-checks/:checkId', (c) => {
      const check = manualChecks.get(c.req.param('checkId'));
      return check ? c.json(check) : c.json({ error: 'not found' }, 404);
    });

  // ---- runs ----------------------------------------------------------------

  // Additive `usage` field (#348): the latest CPU/RSS/proc-count sample of the
  // run's live process tree — absent for finished runs and when `ps` yields
  // nothing. The stored record itself is never touched.
  const withUsage = (run: RunRecord): RunRecord & { usage?: ReturnType<typeof currentUsage> } => {
    const usage = currentUsage(run.id);
    return usage ? { ...run, usage } : run;
  };

  // The inbox half of a composer launch (#374). Since the cockpit's "▶ Run"
  // prefills `/new` instead of calling POST /api/todos/:id/start (never launch
  // blind — #355), the todo id rides along on the composer's POST /api/runs and
  // lands here: `markStarted` writes `startedTaskId`, so the entry leaves the
  // inbox (`visibleTodos()`) and stays in todos.json as the audit trail, and a
  // second launch of the same entry no longer double-starts it.
  //
  // Deliberately best-effort: bookkeeping must never cost the user their task,
  // so an unknown, stale or already-started id (markStarted → false) and any I/O
  // failure only log. The run has already been created by the time we get here.
  const noteTodoStarted = async (dataDir: string, todoId: string, taskId: string): Promise<void> => {
    try {
      if (!(await markStarted(dataDir, todoId, taskId))) {
        console.warn(`[cezar] inbox entry ${todoId} not marked started (unknown or already started)`);
      }
    } catch (err) {
      console.warn(`[cezar] could not mark inbox entry ${todoId} started: ${String(err)}`);
    }
  };

  // ---- chained family: runs lifecycle + artifacts (project-scoped) ----
  const runsRoutes = new Hono<ProjectApiEnv>()
    .get('/runs', (c) => c.json(c.get('project').store.listRuns().map(withUsage)))

    // Registered before the `/:id/...` routes so "archive-finished" never
    // matches as a run id.
    .post('/runs/archive-finished', (c) => c.json({ archived: c.get('project').store.archiveFinished() }))

    .post('/runs/:id/archive', jsonZodValidator(archiveSchema, { absent: ({}) }), async (c) => {
      const { store } = c.get('project');
      const id = c.req.param('id');
      // An empty/absent body archives (the common case); a malformed body degrades
      // to `{}` just as before, but a wrong-typed `archived` is now a 400 (#429).
      const parsed = { data: c.req.valid('json') };
      const run = store.setArchived(id, parsed.data.archived !== false);
      return run ? c.json(run) : c.json({ error: 'not found' }, 404);
    })

    .post('/runs', jsonZodValidator(startRunSchema), async (c) => {
      const { root: repoRoot, dataDir, manager } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      let workflow: WorkflowDef | undefined;
      if (parsed.data.steps) {
        // Inline chain (spec 008): an approved plan runs as an ad-hoc workflow.
        const issue = stepsIssue(parsed.data.steps);
        if (issue) return c.json({ error: issue }, 400);
        workflow = {
          name: '(planned)',
          source: 'built-in',
          steps: parsed.data.steps,
        };
      } else {
        const { workflows } = await loadWorkflows(repoRoot);
        workflow = workflows.find((w) => w.name === parsed.data.workflow);
        if (!workflow) return c.json({ error: `unknown workflow: ${parsed.data.workflow}` }, 404);
      }
      const fallback = parsed.data.runner ?? (await loadConfig(repoRoot)).defaultRunner;
      const blocked = await providerActionError(providersRequiredByWorkflow(workflow, fallback));
      if (blocked) return c.json({ error: blocked }, 409);
      const images = parsed.data.images?.map((img): ContentBlock => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      }));
      const input = {
        task: parsed.data.task,
        model: parsed.data.model,
        runner: parsed.data.runner,
        images,
        systemPrompt: parsed.data.systemPrompt,
        worktree: parsed.data.worktree,
        autonomous: parsed.data.autonomous,
        // Opt-in inbox (#471): the capability is the ceiling, so a client asking
        // for follow-ups on a server that has them off gets a plain `false`
        // rather than an error — the run is still perfectly valid without them.
        // One decision here feeds the run record, the system prompt and
        // CEZ_TODOS_FILE alike (RunManager.agentEnv).
        generateFollowups: capabilities().followups ? parsed.data.generateFollowups : false,
      };
      const variants = parsed.data.variants ?? 1;
      if (variants > 1) {
        // Variants live in worktrees — without git there's nothing to isolate
        // them with, so this degrades to a clear 400 instead of stepping on
        // one shared working tree.
        const repo = await getRepoInfo(repoRoot);
        if (!repo) {
          return c.json(
            {
              error:
                'parallel variants need a git repository (each variant runs in its own worktree) — run ×1 here, or start cezar inside a git repo',
            },
            400,
          );
        }
        const runs = manager.startVariants(workflow, input, variants);
        // The entry points at the first variant — the thread the composer navigates to.
        const first = runs[0];
        if (parsed.data.todoId && first) await noteTodoStarted(dataDir, parsed.data.todoId, first.id);
        return c.json({ runs }, 201);
      }
      const run = manager.startRun(workflow, input);
      if (parsed.data.todoId) await noteTodoStarted(dataDir, parsed.data.todoId, run.id);
      return c.json(run, 201);
    })

    .get('/runs/:id', (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      return run ? c.json(withUsage(run)) : c.json({ error: 'not found' }, 404);
    })

    // Editable titles (#389). The UI displays `titleSummary ?? title`, so a
    // user edit sets BOTH: `title` (the record's own name — the raw task stops
    // being it the moment the user renames the run) and `titleSummary` (what
    // actually displays). The auto-summarizer only ever fills an *unset*
    // titleSummary (RunManager.recordTurnEnd), so an edit wins over any past or
    // future auto-summary. Answers the updated record.
    .patch('/runs/:id', jsonZodValidator(patchRunSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // The prompt is editable only while the run is still queued (#472). Checked
      // BEFORE the title write so a rejected PATCH is a no-op rather than a partial
      // one. `title` itself keeps working on any status — no regression to #389.
      if (parsed.data.task !== undefined) {
        const foldedChars = foldedLength(parsed.data.task, store.getRun(id)?.queuedMessages ?? []);
        if (foldedChars > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${foldedChars})`,
            },
            400,
          );
        }
        if (!manager.editTask(id, parsed.data.task)) {
          return c.json({ error: 'run already started' }, 409);
        }
      }
      if (parsed.data.title !== undefined) {
        // titleOrigin 'user' permanently stops the namer's live updates for this run
        // (spec 2026-07-17-task-auto-naming).
        store.updateRun(id, {
          title: parsed.data.title,
          titleSummary: parsed.data.title,
          titleOrigin: 'user',
        });
      }
      return c.json(store.getRun(id));
    })

    .post('/runs/:id/cancel', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const cancelled = manager.cancel(id);
      return c.json({ cancelled });
    })

    // Live-session participation (spec 002): deliver a user message (text +
    // pasted screenshots) into the run's open claude session.
    .post('/runs/:id/messages', jsonZodValidator(messageSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      // Stacking onto a queued prompt mutates an existing task and invokes no provider.
      // Provider availability still gates live delivery after the record leaves `queued`, but
      // must not strand prompt authoring just because an unrelated fallback provider is
      // disconnected (provider-auth spec: disabling never blocks existing-task mutations).
      // In the dequeue race, the ladder below safely turns this into a starting-state buffer.
      if (run.status !== 'queued') {
        const blocked = await providerActionError([providerForActiveRun(run)]);
        if (blocked) return c.json({ error: blocked }, 409);
      }
      const content: ContentBlock[] = [
        ...parsed.data.images.map((img): ContentBlock => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })),
        ...(parsed.data.text.trim() ? [{ type: 'text', text: parsed.data.text } satisfies ContentBlock] : []),
      ];
      // Three-rung delivery ladder (#472). Branch on the ENGINE's answer rather
      // than a status read here: the handler cannot observe the dequeue safely
      // (the record is written a tick later), the engine can.
      //   live session → delivered · still queued → folded into the prompt
      //   starting up  → buffered  · anything else → 409, exactly as before
      if (manager.sendMessage(id, content)) return c.json({ delivered: true });

      const currentRun = store.getRun(id);
      const stack = currentRun?.queuedMessages ?? [];
      // Bounds apply only to a message that is actually about to be stacked. Without this
      // gate an over-long message posted to a *finished* run would answer `400 prompt too
      // long` when the truthful answer is `409 session closed`. The status read is safe
      // here because it only decides whether to reject EARLY — `enqueueMessage` still
      // re-checks against the engine's own queue before writing anything.
      if (currentRun?.status === 'queued') {
        if (stack.length >= MAX_QUEUED_MESSAGES) {
          return c.json({ error: `too many queued messages — ${MAX_QUEUED_MESSAGES} message limit` }, 400);
        }
        const stackedImages = stack.reduce((n, m) => n + (m.images?.length ?? 0), 0);
        if (stackedImages + parsed.data.images.length > MAX_QUEUED_IMAGES) {
          return c.json({ error: `too many queued images — ${MAX_QUEUED_IMAGES} image limit across the stack` }, 400);
        }
        const prospective = foldedLength(currentRun.task, [...stack, { text: parsed.data.text }]);
        if (prospective > MAX_FOLDED_TASK_CHARS) {
          return c.json(
            {
              error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
            },
            400,
          );
        }
      }

      const queued = manager.enqueueMessage(id, content);
      if (queued) return c.json({ queued: true, message: queued });
      if (manager.deferMessage(id, content)) return c.json({ deferred: true });
      return c.json({ error: 'session closed' }, 409);
    })

    // Edit / remove a stacked message (#472). Registered before any conflicting
    // `/:id` route so `queued-messages` never matches as a run id.
    .patch('/runs/:id/queued-messages/:msgId', jsonZodValidator(queuedMessagePatchSchema), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      const msgId = c.req.param('msgId');
      const stack = run.queuedMessages ?? [];
      const existing = stack.find((m) => m.id === msgId);
      if (!existing) return c.json({ error: 'not found' }, 404);

      const effectiveText = parsed.data.text ?? existing.text;
      const effectiveImageCount = parsed.data.images?.length ?? existing.images?.length ?? 0;
      if (!effectiveText.trim() && effectiveImageCount === 0) {
        return c.json({ error: 'message needs text or at least one image' }, 400);
      }

      const others = stack.filter((m) => m.id !== msgId);
      const stackedImages = others.reduce((n, m) => n + (m.images?.length ?? 0), 0);
      if (stackedImages + effectiveImageCount > MAX_QUEUED_IMAGES) {
        return c.json({ error: `too many queued images — ${MAX_QUEUED_IMAGES} image limit across the stack` }, 400);
      }
      const prospective = foldedLength(run.task, [...others, { text: effectiveText }]);
      if (prospective > MAX_FOLDED_TASK_CHARS) {
        return c.json(
          {
            error: `prompt too long — ${MAX_FOLDED_TASK_CHARS} character limit across the task and its queued messages (would be ${prospective})`,
          },
          400,
        );
      }

      const images: ContentBlock[] | undefined = parsed.data.images?.map(
          (img): ContentBlock => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          }),
        );
      const message = manager.editQueuedMessage(id, msgId, {
        ...(parsed.data.text !== undefined ? { text: parsed.data.text } : {}),
        ...(images !== undefined ? { images } : {}),
      });
      if (!message) return c.json({ error: 'run already started' }, 409);
      return c.json({ message });
    })

    .delete('/runs/:id/queued-messages/:msgId', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      const msgId = c.req.param('msgId');
      if (!(run.queuedMessages ?? []).some((m) => m.id === msgId)) {
        return c.json({ error: 'not found' }, 404);
      }
      if (!manager.removeQueuedMessage(id, msgId)) return c.json({ error: 'run already started' }, 409);
      return c.json({ removed: true });
    })

    // "Finish": gracefully close a waiting session — the run completes as done.
    .post('/runs/:id/finish', (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      const finished = manager.finish(id);
      if (!finished) return c.json({ error: 'no open session' }, 409);
      return c.json({ finished: true });
    })

    // "Continue" (spec 003): reopen a finished run's session in-process.
    .post('/runs/:id/continue', jsonZodValidator(continueSchema, { absent: ({}) }), async (c) => {
      const { store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Bounded resume text (#429); an empty/absent body still just re-runs on the
      // run's current backend, and a runner/model override reopens on that engine (#401).
      const parsed = { data: c.req.valid('json') };
      const blocked = await providerActionError([providerForExistingRun(run, parsed.data.runner)]);
      if (blocked) return c.json({ error: blocked }, 409);
      const result = manager.continueRun(id, {
        text: parsed.data.text,
        images: parsed.data.images?.map((img): ContentBlock => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })),
        runner: parsed.data.runner,
        model: parsed.data.model,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ continued: true });
    })

    // "Open in terminal" (spec 003): hand the session off to a real terminal —
    // in the task's worktree when it still exists (spec 006).
    .post('/runs/:id/open-in-cli', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Hosted mode: there is no "my machine" to open a terminal on. The UI
      // hides the button when localHandoff is false — this is defense in depth.
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error:
              'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE); resume the session from a machine that has the checkout',
          },
          409,
        );
      }
      const sessionId = [...run.steps].reverse().find((s) => s.sessionId)?.sessionId;
      if (!sessionId) return c.json({ error: 'no agent session to resume' }, 409);
      const blocked = await providerActionError([providerForExistingRun(run)]);
      if (blocked) return c.json({ error: blocked }, 409);
      const cwd = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;
      const command = resumeCommand(run.runner, sessionId);
      // Fails closed on an id we do not recognise — see resumeCommand (#431).
      if (!command) return c.json({ error: 'the recorded session id has an unexpected shape' }, 409);
      const opened = await openInTerminal(cwd, command);
      if (!opened) {
        return c.json(
          {
            error: 'no terminal emulator found',
            command: `cd '${cwd}' && ${command}`,
          },
          409,
        );
      }
      return c.json({ opened: true, command });
    })

    // Open a run's worktree (or the repo root) in the chosen local app.
    .post('/runs/:id/open-in', jsonZodValidator(openInSchema), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error: 'local handoff is disabled — this cockpit runs in hosted mode (CEZ_REMOTE)',
          },
          409,
        );
      }
      // Follows the safeParse convention (#429); the downstream allowlist match is the real
      // injection guard, this just validates the shape.
      const parsedBody = { data: c.req.valid('json') };
      const { target, path: relPath } = parsedBody.data;
      const dir = run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : repoRoot;

      // Diff pane "open in OS default app" (#365): one worktree file, opened with the platform's
      // default handler for its type — not a directory in the file manager (that's `finder`
      // above) and not a session takeover (editors/CLIs above). `path` is re-validated against
      // the worktree here regardless of what the schema allowed, so a stale/forged path can never
      // escape it.
      if (target === 'default') {
        if (!run.worktreePath || !existsSync(run.worktreePath)) {
          return c.json({ error: NO_WORKTREE }, 409);
        }
        if (!relPath) return c.json({ error: 'path required for the default-app target' }, 400);
        const result = await readWorktreePath(run.worktreePath, relPath);
        if (result.kind !== 'file') {
          return c.json(
            {
              error: result.kind === 'dir' ? `not a file: ${relPath}` : result.error,
            },
            409,
          );
        }
        // This route's whole contract is "preview an image in its default app", and containment
        // alone does not enforce it. Without this gate any regular file in the worktree — a
        // `.command`/`.desktop` an agent just wrote, an `.exe` — would be handed to the OS
        // launcher, which EXECUTES it. Not remotely reachable (random run ids, same-origin, local
        // mode), so: defense in depth.
        //
        // Deliberately `isOsOpenableImage`, NOT the raw route's `imageMimeType`: that list allows
        // SVG on the strength of an `<img>` + no-script CSP the OS launcher never applies (the
        // default `.svg` handler is usually a browser, which would run the file's `<script>`).
        if (!isOsOpenableImage(result.path)) {
          // Say which rule refused, in the route's own words — "limited to images" would be a lie
          // to someone holding an SVG, which IS an image and DOES preview inline.
          return c.json(
            {
              error: imageMimeType(result.path)
                ? `SVG can carry scripts, so it previews inline but is never handed to the OS: ${result.path}`
                : `opening in the default app is limited to images: ${result.path}`,
            },
            409,
          );
        }
        const filePath = join(run.worktreePath, result.path);
        const opened = await openFileInDefaultApp(filePath);
        if (!opened) return c.json({ error: `could not open ${result.path}`, path: filePath }, 409);
        return c.json({ opened: true, path: filePath });
      }

      // Coding-agent CLI handoff (#cli-handoff, #402): open a terminal in the worktree that resumes
      // THIS run's session when the chosen CLI is the run's own runner (and a session exists), or
      // starts a fresh CLI there otherwise. Same terminal launcher the Terminal button uses.
      // Records that predate the runner choice carry no `runner` at all — they default to Claude
      // everywhere else (resumeCommand, the client's resumeHint/cliTargetResumes), so the match
      // check defaults the same way here; without it, a legacy run's own Claude CLI would never
      // resume its own session, only ever launch fresh.
      // A run the engine still owns never resumes: `sessionId` is seeded when the agent step STARTS
      // (workflows/run.ts), so a running/queued/waiting run already carries one, and resuming it
      // would attach a SECOND CLI process to the transcript the engine is actively writing. Those
      // picks launch the CLI fresh in the worktree — the same degradation as a cross-runner pick,
      // and what the client's cliTargetResumes now labels. Resume-after-finish is untouched.
      const cliRunner = agentCliRunner(target);
      if (cliRunner) {
        const blocked = await providerActionError([cliRunner]);
        if (blocked) return c.json({ error: blocked }, 409);
        const engineOwnsSession = run.status === 'running' || run.status === 'queued' || run.status === 'waiting';
        const sessionId = engineOwnsSession ? undefined : [...run.steps].reverse().find((s) => s.sessionId)?.sessionId;
        // An id resumeCommand refuses (#431) degrades to a fresh CLI in the worktree,
        // exactly like a run that never recorded a session.
        const resume = sessionId && cliRunner === (run.runner ?? 'claude') ? resumeCommand(cliRunner, sessionId) : null;
        const command = resume ?? cliRunner;
        const opened = await openInTerminal(dir, command);
        if (!opened) {
          return c.json(
            {
              error: 'no terminal emulator found',
              command: `cd '${dir}' && ${command}`,
            },
            409,
          );
        }
        return c.json({ opened: true, path: dir, command });
      }

      const opened = await openInApp(target, dir);
      if (!opened) return c.json({ error: `could not open ${target}`, path: dir }, 409);
      return c.json({ opened: true, path: dir });
    })

    // Handoff journal (spec 007): the per-task handoff.md as markdown. 404 only
    // when the task is unknown; a task without a (yet) seeded file returns ''.
    .get('/runs/:id/handoff', (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      return c.text(readHandoff(dataDir, run.id), 200, {
        'content-type': 'text/markdown; charset=utf-8',
      });
    })

    .get('/runs/:id/images/:file', (c) => {
      const { dataDir, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const file = basename(c.req.param('file'));
      const path = join(dataDir, 'runs', `${run.id}-images`, file);
      if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
      const type = IMAGE_TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream';
      return new Response(readFileSync(path), {
        headers: {
          'content-type': type,
          'cache-control': 'private, max-age=31536000, immutable',
        },
      });
    })

    // Task diff (spec 006): what this run changed — its worktree vs its base.
    .get('/runs/:id/diff', async (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      if (!run.worktreePath || !existsSync(run.worktreePath)) {
        return c.text('(no worktree — this task ran directly in the repo working tree)');
      }
      return c.text(await worktreeDiff(run.worktreePath, run.baseBranch ?? 'HEAD'));
    })

    .get('/runs/:id/changes', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectChanges(workingDirectory, run.baseBranch ?? 'HEAD', {
        taskBranch: run.branch,
        // A read-only GET against the user's real checkout must never modify its index.
        intentToAdd: run.worktreePath ? undefined : false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    // The run's own commits (<base>..HEAD on the worktree branch) — the Commits tab.
    .get('/runs/:id/commits', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectRunCommits(workingDirectory, run.baseBranch ?? 'HEAD');
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ commits: result.commits });
    })

    // One of the run's commits, structured like the Changes tab (reuses collectCommitChanges).
    .get('/runs/:id/commit/:sha', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await collectCommitChanges(workingDirectory, c.req.param('sha'));
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.commit);
    })

    // Files tab: directory listing (path omitted or a dir) or file content
    // (size-capped, binary flagged). Traversal-safe — readWorktreePath rejects
    // anything escaping the worktree. `raw=1` (R5 Step 1.6) serves the BYTES of
    // image files only, for the preview's inline <img> — never HTML/JS/etc., so
    // no worktree file can become a same-origin document, and never past the
    // size cap. The no-script CSP neutralizes SVG opened as a top-level URL.
    //
    // An `Accept` that asks for images reaches the same raw branch without the flag — which is
    // what an `<img>` sends — while the flag still wins whenever it is present and `*<slash>*`
    // (every `fetch`) still gets the JSON listing. See `negotiate`.
    .get('/runs/:id/files', queryZodValidator(z.object({ path: queryValue, raw: queryValue })), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      const query = c.req.valid('query');
      c.header('vary', 'Accept');
      const wantsRaw =
        query.raw !== undefined
          ? query.raw === '1'
          : negotiate(c.req.header('accept'), FILE_FORMATS) === 'image/*';
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const workingDirectory = workingDirectoryOf(run, repoRoot);
      if (!workingDirectory) return c.json({ error: NO_WORKTREE }, 409);
      const result = await readWorktreePath(workingDirectory, query.path ?? '');
      if (result.kind === 'invalid' || result.kind === 'missing') {
        return c.json({ error: result.error }, 409);
      }
      if (result.kind === 'dir') {
        return c.json({
          // `as const` or the literal widens to `string` during Hono's route-type inference,
          // which erases the discriminant a consumer narrows on — `entry.type === 'dir'` then
          // leaves `never` and every field access on it fails. The wire was always 'dir'.
          type: 'dir' as const,
          path: result.path,
          entries: result.entries,
        });
      }
      if (wantsRaw) {
        const mime = imageMimeType(result.path);
        if (mime === null || result.tooLarge) {
          // `?raw=1` ASKED for bytes, so it hears why it cannot have them — that 409 and its
          // wording are the protected surface (§2). An `Accept` is only a preference, so a
          // resource with no image representation falls THROUGH to the JSON answer below rather
          // than turning a browser's navigation to a text file into an error.
          if (query.raw !== undefined) {
            const error =
              mime === null
                ? `raw serving is limited to images: ${result.path}`
                : `file too large to serve raw (${result.size} bytes): ${result.path}`;
            return c.json({ error }, 409);
          }
        } else {
          const bytes = await readFile(join(workingDirectory, result.path));
          return c.body(new Uint8Array(bytes).buffer as ArrayBuffer, 200, {
            'content-type': mime,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          });
        }
      }
      return c.json({
        type: 'file' as const,
        path: result.path,
        size: result.size,
        binary: result.binary,
        tooLarge: result.tooLarge,
        ...(result.content !== undefined ? { content: result.content } : {}),
      });
    })

    .post('/runs/:id/git/commit', jsonZodValidator(gitCommitSchema), async (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const worktree = worktreeOf(run);
      if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
      const parsed = { data: c.req.valid('json') };
      const result = await commitAll(worktree, parsed.data.message);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ committed: true, sha: result.sha });
    })

    .post('/runs/:id/git/push', async (c) => {
      const { store } = c.get('project');
      const run = store.getRun(c.req.param('id'));
      if (!run) return c.json({ error: 'not found' }, 404);
      const worktree = worktreeOf(run);
      if (!worktree) return c.json({ error: NO_WORKTREE }, 409);
      const result = await pushCurrentBranch(worktree);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({
        pushed: true,
        branch: result.branch,
        remote: result.remote,
        upstreamSet: result.upstreamSet,
      });
    })

    // Draft PR from the review gate (spec 009): final autosave → push →
    // `gh pr create --draft`; on success the run completes as done with the PR
    // badge. Failures come back as 409 with a `manual` merge command the GUI
    // shows next to the toast. CEZ_DRY_RUN=1 fakes the URL (no push, no gh).
    .post('/runs/:id/pr', async (c) => {
      const { root: repoRoot, dataDir, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (manager.isActive(id)) return c.json({ error: 'run is still active — wait for the review gate' }, 409);
      if (!run.worktreePath || !existsSync(run.worktreePath) || !run.branch) {
        return c.json(
          {
            error: 'no worktree/branch to publish — this task ran in the repo working tree',
          },
          400,
        );
      }
      const outcome = await createDraftPr({
        repoRoot,
        run,
        handoffText: readHandoff(dataDir, id),
      });
      if (!outcome.ok) {
        return c.json({ error: outcome.error, manual: `git merge ${run.branch}` }, 409);
      }
      store.updateRun(id, {
        pullRequestUrl: outcome.url,
        status: 'done',
        finishedAt: run.finishedAt ?? new Date().toISOString(),
      });
      store.appendEvent(id, {
        type: 'note',
        message: `draft PR created: ${outcome.url}${outcome.dryRun ? ' (dry run — no real PR)' : ''}`,
      });
      return c.json({ url: outcome.url, dryRun: outcome.dryRun }, 201);
    })

    // Archived tasks keep their worktree for inspection; this is the explicit
    // "🧹 Remove worktree" cleanup (spec 006).
    .post('/runs/:id/remove-worktree', async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
      if (run.worktreePath) await removeWorktree(repoRoot, run.worktreePath, run.branch);
      store.updateRun(id, { worktreePath: undefined, branch: undefined });
      return c.json({ removed: true });
    })

    .delete('/runs/:id', async (c) => {
      const { root: repoRoot, store, manager } = c.get('project');
      const id = c.req.param('id');
      if (manager.isActive(id)) return c.json({ error: 'run is active — cancel it first' }, 409);
      const run = store.getRun(id);
      if (!run) return c.json({ error: 'not found' }, 404);
      // Delete cleans up after itself: worktree + branch go with the run (spec 006).
      if (run.worktreePath) await removeWorktree(repoRoot, run.worktreePath, run.branch);
      return store.deleteRun(id) ? c.json({ deleted: true }) : c.json({ error: 'not found' }, 404);
    });

  // ---- parallel variants (spec 010) -----------------------------------------

  const groupRuns = (store: RunStore, groupId: string): RunRecord[] =>
    store
      .listRuns()
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => (a.variant ?? '').localeCompare(b.variant ?? ''));

  // ---- chained family: variant groups (project-scoped) ----
  const groupsRoutes = new Hono<ProjectApiEnv>()
    .get('/groups/:groupId', async (c) => {
      const { dataDir, store } = c.get('project');
      const runs = groupRuns(store, c.req.param('groupId'));
      if (runs.length === 0) return c.json({ error: 'not found' }, 404);
      const detailed = await Promise.all(
        runs.map(async (r): Promise<GroupVariant> => ({
          id: r.id,
          variant: r.variant ?? '?',
          title: r.title,
          status: r.status,
          archived: r.archived,
          tokensUsed: r.tokensUsed,
          ...(r.inputTokens !== undefined ? { inputTokens: r.inputTokens } : {}),
          ...(r.outputTokens !== undefined ? { outputTokens: r.outputTokens } : {}),
          ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
          diffStat:
            r.worktreePath && existsSync(r.worktreePath)
              ? await worktreeDiffStat(r.worktreePath, r.baseBranch ?? 'HEAD')
              : '',
          handoffExcerpt: handoffProgressExcerpt(readHandoff(dataDir, r.id)),
        })),
      );
      return c.json({
        groupId: c.req.param('groupId'),
        runs: detailed,
      } satisfies GroupResponse);
    })

    // "Pick this one": the winner rests at `review` (spec 009 takes it from
    // there — send back / draft PR / finish); the losers are cancelled if
    // alive, archived, and their worktrees + branches removed.
    .post('/groups/:groupId/pick', jsonZodValidator(pickSchema), async (c) => {
      const { root: repoRoot, dataDir, store, manager } = c.get('project');
      const runs = groupRuns(store, c.req.param('groupId'));
      if (runs.length === 0) return c.json({ error: 'not found' }, 404);
      const parsed = { data: c.req.valid('json') };
      const winner = runs.find((r) => r.id === parsed.data.runId);
      if (!winner) return c.json({ error: 'runId is not part of this group' }, 404);
      if (manager.isActive(winner.id)) {
        return c.json({ error: 'this variant is still active — wait for it to finish first' }, 409);
      }

      // Winner: a non-review terminal state with a non-empty diff flips to
      // `review` (the settleSuccess rule) — but only when the review gate applies
      // (#489): it is enabled (`reviewGateEnabled`, default off) AND the winner is
      // not autonomous. An autonomous / gate-off winner keeps its `done` state with
      // the diff left in the worktree; an empty diff (or no worktree) stays too.
      if (
        winner.status !== 'review' &&
        winner.worktreePath &&
        existsSync(winner.worktreePath) &&
        winner.autonomous !== true &&
        reviewGateEnabled(await loadConfig(repoRoot))
      ) {
        const diff = await worktreeDiff(winner.worktreePath, winner.baseBranch ?? 'HEAD');
        if (diff.trim().length > 0 && !diff.startsWith('(diff failed')) {
          store.updateRun(winner.id, { status: 'review' });
        }
      }
      const losers = runs.filter((r) => r.id !== winner.id);
      store.appendEvent(winner.id, {
        type: 'lifecycle',
        message: `picked from ${runs.length} variants — ${losers.length} other variant(s) archived`,
      });
      appendHandoffHeartbeat(dataDir, winner.id, `picked from ${runs.length} variants`);

      for (const loser of losers) {
        if (manager.isActive(loser.id)) manager.cancel(loser.id);
        if (loser.worktreePath) await removeWorktree(repoRoot, loser.worktreePath, loser.branch);
        store.updateRun(loser.id, { worktreePath: undefined, branch: undefined });
        store.setArchived(loser.id, true);
        store.appendEvent(loser.id, {
          type: 'lifecycle',
          message: `variant ${winner.variant ?? '?'} was picked — this variant is archived, its worktree removed`,
        });
      }
      // Spread: `getRun` may answer undefined, and an undefined VALUE is dropped by
      // JSON.stringify — so writing the key unconditionally typed the route as sending a key it
      // does not. contract/workflows.ts says `.optional()`, which is what a client receives.
      const picked = store.getRun(winner.id);
      return c.json({ ...(picked !== undefined ? { winner: picked } : {}) });
    });

  // ---- chained family: open-targets (project-scoped) ----
  const openTargetsRoutes = new Hono<ProjectApiEnv>()
    .get('/open-targets', (c) => c.json({ targets: capabilities().localHandoff ? detectOpenTargets() : [] }));

  // Agent screenshots — image blocks the run manager persisted out of tool
  // results (persistImage). `basename` pins reads inside the run's own dir.
  const IMAGE_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  // ---- session git view (redesign R5 Step 1.2 — §"Git/session API additions").
  // Structured sibling of the text-blob /diff above (which stays untouched —
  // protected surface). Isolated runs read their worktree; worktree-off runs
  // read the repo checkout they executed in. Every predictable git failure
  // degrades to 409 + human-readable reason, 404 only for unknown ids.
  const worktreeOf = (run: RunRecord): string | null =>
    run.worktreePath && existsSync(run.worktreePath) ? run.worktreePath : null;
  const workingDirectoryOf = (run: RunRecord, repoRoot: string): string | null =>
    run.worktree === false
      ? repoRoot
      : worktreeOf(run);
  const NO_WORKTREE = 'no worktree — this task ran directly in the repo working tree';

  // ---- chained family: worktrees (project-scoped) ----
  const worktreesRoutes = new Hono<ProjectApiEnv>()
    .get('/worktrees', async (c) => {
      const { root: repoRoot, store } = c.get('project');
      // The keep-limit the panel reports is the one the enforcer will actually
      // apply — inherited from the workspace default when this repo sets none.
      const keep = await resolveWorktreeRetention(repoRoot);
      const runs = store.listRuns().filter((r) => r.worktreePath && existsSync(r.worktreePath));
      const worktrees = await Promise.all(
        runs.map(async (r) => ({
          runId: r.id,
          title: r.title ?? r.id,
          status: r.status,
          branch: r.branch ?? null,
          // POSIX `du` — degrades to null (Windows / du missing / error); never blocks.
          sizeBytes: await worktreeSizeBytes(r.worktreePath as string),
          finishedAt: r.finishedAt ?? null,
          reclaimable: isReclaimable(r),
        })),
      );
      // Total is null when any size degraded, so the panel never shows a wrong sum.
      const totalBytes = worktrees.some((w) => w.sizeBytes === null)
        ? null
        : worktrees.reduce((sum, w) => sum + (w.sizeBytes ?? 0), 0);
      return c.json({ worktrees, totalBytes, keep });
    })

    .post('/worktrees/reclaim', jsonZodValidator(() => reclaimBodySchema, { absent: ({}), message: 'invalid body' }), async (c) => {
      const { root: repoRoot, store } = c.get('project');
      // The body is validated (an empty or `{}` one is accepted) but carries nothing this
      // handler reads; retention is best-effort, so 200 always.
      const reclaimed = await reclaimWorktrees(repoRoot, store, await resolveWorktreeRetention(repoRoot));
      return c.json({ reclaimed });
    });

  const reclaimBodySchema = z.object({}).passthrough();

  /**
   * "The inbox is on and this entry exists" — the 409/404 half of `POST /todos/:id/start`, lifted
   * out of the handler and in FRONT of the body validator.
   *
   * That position is the whole point. The route's contract is that an unknown id 404s before the
   * body is looked at, and Hono only records a body in the route type when it is validated as
   * MIDDLEWARE — which necessarily runs before the handler. Registering this guard first satisfies
   * both: the documented status order is unchanged, and `startTodoSchema` becomes visible to
   * `AppType` (and so to `hc`) instead of being parsed invisibly inside the handler.
   *
   * Deliberately NOT annotated with a return type: the inferred one carries the two typed
   * responses, which is what keeps the 409 and 404 branches in the route's schema for the client.
   */
  const todoMustExist = async (c: Context<TodoStartEnv, '/todos/:id/start'>, next: Next) => {
    if (!capabilities().followups) return c.json({ error: FOLLOWUPS_OFF }, 409);
    const todo = (await readTodos(c.get('project').dataDir)).find((t) => t.id === c.req.param('id'));
    if (!todo) return c.json({ error: 'not found' }, 404);
    c.set('todo', todo);
    await next();
  };

  // ---- chained family: follow-up inbox / todos (project-scoped) ----
  const todosRoutes = new Hono<ProjectApiEnv>()
    .get('/todos', async (c) => c.json(capabilities().followups ? await readTodos(c.get('project').dataDir) : []))

    // Check off = delete the entry.
    .delete('/todos/:id', async (c) => {
      const { dataDir } = c.get('project');
      if (!capabilities().followups) return c.json({ error: FOLLOWUPS_OFF }, 409);
      const removed = await removeTodo(dataDir, c.req.param('id'));
      return removed ? c.json({ removed: true }) : c.json({ error: 'not found' }, 404);
    })

    // "▶ Run": turn an inbox entry into a task — a one-off single-step workflow
    // around the suggested skill when it exists, plain quick-task otherwise.
    //
    // TWO middlewares, and their ORDER is the contract. This route's documented status order
    // (pinned by todos-start.test.ts) is that a disabled inbox 409s and an unknown id 404s BEFORE
    // the body is looked at — which is why the body used to be parsed inline, invisible to `hc`.
    // Hono runs route middleware in registration order, so `todoMustExist` FIRST keeps that order
    // exactly while `jsonZodValidator` second is what records the body in the route type.
    //
    // The two no-body cases the old inline parse distinguished are carried by the validator's
    // `absent`/`malformed` options: no body at all is `undefined` (the pre-#401 bodyless POST,
    // which the optional schema accepts → 201), a truncated payload is `null` (which it rejects
    // → 400, rather than passing as "no body" and silently starting a run).
    .post(
      '/todos/:id/start',
      todoMustExist,
      jsonZodValidator(startTodoSchema, { absent: undefined, malformed: null }),
      async (c) => {
        const { root: repoRoot, dataDir, manager } = c.get('project');
        const id = c.req.param('id');
        const todo = c.get('todo');
        const parsed = { data: c.req.valid('json') };
        if (todo.startedTaskId) return c.json({ error: 'already started' }, 409);

        let task = todoTaskText(todo);
        if (parsed.data?.prompt) task += `\n\n${parsed.data.prompt}`;

        let workflow: WorkflowDef | undefined;
        if (todo.suggestedSkill) {
          const skills = await discoverSkills(repoRoot);
          if (skills.some((s) => s.name === todo.suggestedSkill)) {
            workflow = {
              name: '(inbox)',
              description: `Follow-up from the inbox — skill "${todo.suggestedSkill}"`,
              source: 'built-in',
              steps: [
                {
                  id: 'task',
                  name: 'Do the task',
                  skill: todo.suggestedSkill,
                  prompt: '{{task}}',
                },
              ],
            };
          }
        }
        if (!workflow) {
          const { workflows } = await loadWorkflows(repoRoot);
          workflow = workflows.find((w) => w.name === 'quick-task') ?? QUICK_TASK_WORKFLOW;
        }

        const fallback = parsed.data?.runner ?? (await loadConfig(repoRoot)).defaultRunner;
        const blocked = await providerActionError(providersRequiredByWorkflow(workflow, fallback));
        if (blocked) return c.json({ error: blocked }, 409);

        const run = manager.startRun(workflow, {
          task,
          runner: parsed.data?.runner,
          model: parsed.data?.model,
        });
        await markStarted(dataDir, id, run.id);
        return c.json({ run }, 201);
      },
    );

  // ---- chained family: SSE streams (project-scoped) ----
  const sseRoutes = new Hono<ProjectApiEnv>()
    .get('/runs/:id/events', (c) => {
      const { store } = c.get('project');
      const id = c.req.param('id');
      if (!store.getRun(id)) return c.json({ error: 'not found' }, 404);
      return streamSSENoBuffer(c, async (stream) => {
        let replaying = true;
        let maxSeq = 0;
        const buffered: RunEvent[] = [];
        // One endpoint, two SSE event names: v1 lines stay `run-event` (the name
        // the legacy UI listened to — its default branch JSON-dumped unknown
        // types into the transcript, which is why v2 never rode that name; the
        // split outlives the R7 retirement as wire shape); protocol-v2 lines
        // (dotted types, persisted snapshots AND ephemeral coalesced deltas)
        // ride `ui-event`, which only v2-aware clients subscribe to.
        // EventSource ignores names it has no listener for.
        const writeEvent = (event: RunEvent) =>
          stream.writeSSE({
            event: isV2WireEventType(event.type) ? 'ui-event' : 'run-event',
            data: JSON.stringify(event),
          });
        const onEvent = (payload: { runId: string; event: RunEvent }) => {
          if (payload.runId !== id) return;
          if (replaying) buffered.push(payload.event);
          else void writeEvent(payload.event);
        };
        const onRun = (run: RunRecord) => {
          if (run.id !== id) return;
          void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
        };
        store.on('event', onEvent);
        store.on('run', onRun);
        stream.onAbort(() => {
          store.off('event', onEvent);
          store.off('run', onRun);
        });

        for (const event of store.readEvents(id)) {
          maxSeq = Math.max(maxSeq, event.seq);
          await writeEvent(event);
        }
        replaying = false;
        for (const event of buffered) {
          if (event.seq > maxSeq) await writeEvent(event);
        }
        const run = store.getRun(id);
        if (run) await stream.writeSSE({ event: 'run', data: JSON.stringify(run) });

        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    })

    // Global SSE: run-summary updates for the list view + inbox changes.
    // Scoped `/p/:projectId/events` carries that project's stream in today's
    // shape; the legacy unprefixed alias stays bound to the boot project ONLY
    // (spec "Legacy aliases" — widening it would be a silent behavioral break;
    // the all-project stream arrives as `/api/workspace/events` in step 2.8).
    .get('/events', (c) => {
      const { dataDir, store } = c.get('project');
      return streamSSENoBuffer(c, async (stream) => {
        const onRun = (run: RunRecord) => void stream.writeSSE({ event: 'run', data: JSON.stringify(run) });
        const onDeleted = (id: string) =>
          void stream.writeSSE({
            event: 'run-deleted',
            data: JSON.stringify({ id }),
          });
        const sendTodos = async () => {
          const items: TodoItem[] = await readTodos(dataDir).catch(() => []);
          await stream.writeSSE({ event: 'todos', data: JSON.stringify(items) });
        };
        // Opt-in inbox (#471): subscribing is what creates this project's
        // watcher (step 2.3), so with the capability off we never subscribe —
        // no watcher, no fd. Scoped to this stream's dataDir: another
        // project's todos.json writes never reach this connection.
        const offTodos = capabilities().followups ? onTodosChanged(dataDir, () => void sendTodos()) : () => undefined;
        // Live resource telemetry (#348): the sampler ticks ~every 2 s only
        // while some run has a registered process; each tick is relayed as one
        // `usage` message (runId → {cpuPct, rssBytes, procCount}). Never
        // persisted — the NDJSON transcripts stay usage-free. The sampler is
        // module-global, so a snapshot carries EVERY project's runs — split it
        // by ownership and relay only this project's rows, never a stamped
        // whole (multi-project spec, step 2.4: filtered, not stamped).
        const offUsage = onUsage((usage) => {
          const owned: typeof usage = {};
          for (const [runId, sample] of Object.entries(usage)) {
            if (store.getRun(runId)) owned[runId] = sample;
          }
          void stream.writeSSE({ event: 'usage', data: JSON.stringify(owned) });
        });
        store.on('run', onRun);
        store.on('deleted', onDeleted);
        stream.onAbort(() => {
          store.off('run', onRun);
          store.off('deleted', onDeleted);
          offTodos();
          offUsage();
        });
        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });

  // ---- chained family: workspace SSE stream (workspace-level) ----
  const workspaceEventsRoutes = new Hono<ProjectApiEnv>()
    .get('/workspace/events', (c) => {
      return streamSSENoBuffer(c, async (stream) => {
        // One detach bundle per attached project — the id guard makes a double
        // attach (connect-time snapshot vs. the built hook) impossible.
        const attached = new Map<string, { store: RunStore; detach: () => void }>();
        const attach = (project: string, ctx: Pick<ProjectContext, 'store' | 'dataDir'>): void => {
          if (attached.has(project)) return;
          const { store, dataDir } = ctx;
          const onRun = (run: RunRecord) =>
            void stream.writeSSE({
              event: 'run',
              data: JSON.stringify({ ...run, project }),
            });
          const onDeleted = (id: string) =>
            void stream.writeSSE({
              event: 'run-deleted',
              data: JSON.stringify({ id, project }),
            });
          const sendTodos = async () => {
            const items: TodoItem[] = await readTodos(dataDir).catch(() => []);
            await stream.writeSSE({
              event: 'todos',
              data: JSON.stringify({ project, items }),
            });
          };
          // Same opt-in gate as the per-project stream (#471): no capability, no
          // watcher — and each subscription is scoped to its own dataDir (2.3).
          const offTodos = capabilities().followups ? onTodosChanged(dataDir, () => void sendTodos()) : () => undefined;
          store.on('run', onRun);
          store.on('deleted', onDeleted);
          attached.set(project, {
            store,
            detach: () => {
              store.off('run', onRun);
              store.off('deleted', onDeleted);
              offTodos();
            },
          });
        };

        // The boot context never lives in the lazy map — seed it under its
        // registry id (`resolveBootProject`, NOT `bootContext.id`, which may be
        // the reserved alias when registration was suppressed).
        attach(await resolveBootProject(), bootContext);
        // NB: snapshot + hook subscription happen in one sync block, so no
        // context can slip between them.
        for (const id of contexts.ids()) {
          const ctx = contexts.peek(id);
          if (ctx) attach(ctx.id, ctx);
        }
        const offBuilt = contexts.onContextBuilt((ctx) => attach(ctx.id, ctx));

        // `usage` is FILTERED per project, never a stamped whole (spec "SSE
        // streams"): the module-global sampler's snapshot is split by each
        // attached project's owned runIds, one event per project that has live
        // rows. No event for a row-less project — the workspace stream carries
        // no empty-record clears (that is the per-project streams' contract).
        const offUsage = onUsage((usage) => {
          const rows = Object.entries(usage);
          for (const [project, { store }] of attached) {
            const owned: typeof usage = {};
            for (const [runId, sample] of rows) {
              if (store.getRun(runId)) owned[runId] = sample;
            }
            if (Object.keys(owned).length > 0) {
              void stream.writeSSE({
                event: 'usage',
                data: JSON.stringify({ project, usage: owned }),
              });
            }
          }
        });

        // Workspace-level events (project-added / project-removed /
        // checkout-progress plus host-wide unstamped provider-status) — relayed
        // verbatim under their own names. A removal also drops the project's
        // attach entry: the id guard in `attach` would otherwise pin the
        // DISPOSED context forever, so a project removed and re-added on the
        // same slug would rebuild a fresh context whose events never reach this
        // already-open stream.
        const offWorkspace = workspaceEvents.on((event, data) => {
          if (event === 'project-removed') {
            const removed = (data as { id?: string }).id;
            if (removed !== undefined && attached.has(removed)) {
              attached.get(removed)?.detach();
              attached.delete(removed);
            }
          }
          void stream.writeSSE({ event, data: JSON.stringify(data) });
        });

        stream.onAbort(() => {
          offBuilt();
          offUsage();
          offWorkspace();
          for (const { detach } of attached.values()) detach();
          attached.clear();
        });

        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      });
    });

  // ---- chained family: GitHub (project-scoped) ----
  // These sit ABOVE the routes rather than with the family's other schemas below it, because a
  // validator argument is evaluated when the route is REGISTERED — a schema declared further down
  // would be in its temporal dead zone. (The schemas below are all read inside a handler, or
  // passed as a thunk, which defers them past that point.)
  const mergeNumberParams = z.object({ number: z.coerce.number().int().positive() });
  const prChangesParams = z.object({ number: z.coerce.number().int().positive().safe() });
  const prChangesQuery = z.object({ refresh: queryValue.refine((v) => v === undefined || v === '1') });
  const githubRoutes = new Hono<ProjectApiEnv>()
    .get(
      '/github',
      // `limit` stays a bare string: the handler's `Number.parseInt`/`Number.isFinite` fallback to
      // 30 already accepts `?limit=banana`, and a numeric schema would 400 it instead.
      queryZodValidator(z.object({ limit: queryValue, refresh: queryValue })),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const query = c.req.valid('query');
        const limit = Number.parseInt(query.limit ?? '', 10);
        return c.json(await fetchGithub(repoRoot, query.refresh === '1', Number.isFinite(limit) ? limit : 30));
      },
    )

    .get('/github/comments/:kind/:number', queryZodValidator(refreshQuery), async (c) => {
      const { root: repoRoot } = c.get('project');
      const parsed = commentsParams.safeParse({
        kind: c.req.param('kind'),
        number: c.req.param('number'),
      });
      if (!parsed.success) return c.json({ error: 'invalid kind or number' }, 400);
      return c.json(
        await fetchGithubComments(repoRoot, parsed.data.kind, parsed.data.number, c.req.valid('query').refresh === '1'),
      );
    })

    // Lazy checks glyphs for on-screen PR rows (#664). Additive sibling of /api/github — the list
    // call dropped `statusCheckRollup` (the dominant cost), so the glyph is hydrated here per
    // visible row. `prs` is a comma-separated list of positive integers, capped at GH_CHECKS_MAX;
    // anything malformed is a 400. Same in-payload availability degrade as the list (never a 5xx).
    // `prs` is the one genuinely REQUIRED query key on this server, so it is the one validated
    // strictly — `.min(1)` because `?prs=` answered `missing prs query` before it answered
    // `invalid prs query`, and both spellings must keep their own words.
    .get('/github/checks', queryZodValidator(z.object({ prs: z.string().min(1) }), { message: 'missing prs query' }), async (c) => {
      const { root: repoRoot } = c.get('project');
      const raw = c.req.valid('query').prs;
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0 || parts.length > GH_CHECKS_MAX) return c.json({ error: 'invalid prs query' }, 400);
      const numbers: number[] = [];
      for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n <= 0 || String(n) !== part) return c.json({ error: 'invalid prs query' }, 400);
        numbers.push(n);
      }
      return c.json(await fetchGithubChecks(repoRoot, numbers));
    })

    .get(
      '/github/prs/:number/merge-state',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      queryZodValidator(refreshQuery),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        const forge = resolveForge(await getRepoInfo(repoRoot));
        if (!forge?.prMergeState) return c.json({ available: false, reason: 'GitHub merge state is unavailable' });
        return c.json(await forge.prMergeState(parsed.data.number, { refresh: c.req.valid('query').refresh === '1' }));
      },
    )

    .post(
      '/github/prs/:number/merge',
      paramZodValidator(mergeNumberParams, { message: 'invalid pull request number' }),
      jsonZodValidator(() => mergeBodySchema, { message: 'invalid merge request' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsedNumber = { data: c.req.valid('param') };
        const body = { data: c.req.valid('json') };
        const forge = resolveForge(await getRepoInfo(repoRoot));
        if (!forge?.mergePR) return c.json({ error: 'GitHub merge is unavailable' }, 409);
        const result = await forge.mergePR(parsedNumber.data.number, body.data);
        if (result.merged) return c.json(result);
        return c.json(
          {
            error: result.error,
            ...(result.code ? { code: result.code } : {}),
            ...(result.current ? { current: result.current } : {}),
          },
          result.status,
        );
      },
    )

    .get(
      '/github/prs/:number/changes',
      // Split out of one `safeParse` over both inputs, because a path param and the query string
      // are separate validation targets to Hono and only a split makes each visible to the route
      // type. Both keep the single 400 sentence the combined parse answered. `refresh` stays
      // STRICT here (`?refresh=true` is a 400 today, unlike everywhere else on this server).
      paramZodValidator(prChangesParams, { message: 'invalid pull request number or refresh flag' }),
      queryZodValidator(prChangesQuery, { message: 'invalid pull request number or refresh flag' }),
      async (c) => {
        const { root: repoRoot } = c.get('project');
        const parsed = { data: c.req.valid('param') };
        try {
          return c.json(
            await fetchGithubPrDiff(repoRoot, parsed.data.number, c.req.valid('query').refresh === '1'),
          );
        } catch (err) {
          if (err instanceof GithubPrNotFoundError) return c.json({ error: err.message }, 404);
          throw err;
        }
      },
    );

  // The full comment thread for one issue/PR (#499). Additive sibling of /api/github — lazy
  // (fetched only while a detail view is open), zod-validated params, 400 on garbage, and the
  // same in-payload availability degrade (gh missing / offline / 404 all render as a hint).
  const commentsParams = z.object({
    kind: z.enum(['issue', 'pr']),
    number: z.coerce.number().int().positive(),
  });
  const mergeBodySchema = z.object({
    method: z.enum(['merge', 'squash', 'rebase']),
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    overrideRules: z.boolean().optional().default(false),
  }).strict();

  // ---- chained family: repo / git (project-scoped) ----
  const repoRoutes = new Hono<ProjectApiEnv>()
    .get('/repo', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info)
        return c.json({
          info: null,
          status: [],
          log: [],
          branches: [],
          baseBranch: null,
        });
      const [status, log, branches, config] = await Promise.all([
        getStatus(info.root),
        getLog(info.root),
        getBranches(info.root),
        loadConfig(repoRoot),
      ]);
      return c.json({
        info,
        status,
        log,
        branches,
        baseBranch: config.baseBranch ?? null,
      });
    })

    .get('/repo/diff', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.text('not a git repository');
      return c.text(await getDiff(info.root));
    })

    // One commit's message + stat + patch — the Repo view expands it inline.
    // `?structured=1` is the ADDITIVE sibling (R5 Step 1.7): the new repo view's commit-diff
    // shape `{sha, subject, author, when, files, stat}` with 409 + reason on failure. The
    // legacy text answer below is a protected surface (BACKWARD_COMPATIBILITY.md §2) — its
    // shape, including the in-band failure sentences, stays exactly as it was.
    //
    // `Accept: application/json` reaches the same structured answer without the flag, and
    // `Accept: text/plain` asks for the blob; the flag still wins whenever it is present, and a
    // request with no opinion still gets the blob. See `negotiate`.
    .get('/repo/commit/:sha', queryZodValidator(z.object({ structured: queryValue })), async (c) => {
      const { root: repoRoot } = c.get('project');
      c.header('vary', 'Accept');
      const { structured } = c.req.valid('query');
      const wantsJson =
        structured !== undefined
          ? structured === '1'
          : negotiate(c.req.header('accept'), COMMIT_FORMATS) === 'application/json';
      const info = await getRepoInfo(repoRoot);
      if (wantsJson) {
        if (!info) return c.json({ error: 'not a git repository' }, 409);
        const result = await collectCommitChanges(info.root, c.req.param('sha'));
        if (!result.ok) return c.json({ error: result.error }, 409);
        return c.json(result.commit);
      }
      if (!info) return c.text('not a git repository');
      try {
        return c.text(await getCommit(info.root, c.req.param('sha')));
      } catch (err) {
        return c.text(`(git show failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    })

    // Structured sibling of the text-blob /api/repo/diff above (protected
    // surface, untouched): the same {files, stat} shape the session /changes
    // route serves, here for the MAIN working tree's uncommitted changes vs
    // HEAD (redesign R5 Step 1.3 — §"Git/session API additions").
    .get('/repo/changes', async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      // The user's REAL working tree — never stage into their index (a GET must not write).
      const result = await collectChanges(info.root, 'HEAD', {
        intentToAdd: false,
      });
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json(result.changes);
    })

    .post('/repo/branch', jsonZodValidator(() => repoBranchSchema), async (c) => {
      const { root: repoRoot } = c.get('project');
      const info = await getRepoInfo(repoRoot);
      if (!info) return c.json({ error: 'not a git repository' }, 409);
      const parsed = { data: c.req.valid('json') };
      const result = await createOrSwitchBranch(info.root, parsed.data.name, parsed.data.from);
      if (!result.ok) return c.json({ error: result.error }, 409);
      return c.json({ branch: result.branch, created: result.created });
    });

  // The Settings → Agents knobs in one read (R6 Step 1.5) — an ADDITIVE
  // sibling of PUT /api/config below; /api/health keeps its protected shape.
  const configAnswer = (config: CezConfig) => ({
    baseBranch: config.baseBranch ?? null,
    defaultRunner: config.defaultRunner,
    systemPrompt: config.systemPrompt ?? null,
    defaultModels: config.defaultModels ?? {},
    maxParallel: config.maxParallel,
    memoryLimitMb: config.memoryLimitMb ?? null,
    // Count-based worktree retention (#483): keep the last N finished worktrees
    // on disk. 0 = unlimited. Always materialized (schema default 10).
    worktreeRetention: config.worktreeRetention,
    // Live title updates (task auto-naming spec): tri-state — null means "no
    // config key, the CEZ_TITLE_UPDATES env default (ON) decides".
    liveTitleUpdates: config.liveTitleUpdates ?? null,
    // Optional review gate (#489): tri-state — null means "no config key, the
    // CEZ_REVIEW_GATE env default (OFF) decides".
    reviewGate: config.reviewGate ?? null,
  });
  // ---- chained family: per-repo config (project-scoped) ----
  const configRoutes = new Hono<ProjectApiEnv>()
    .get('/config', async (c) => c.json(configAnswer(await loadConfig(c.get('project').root))))

    .put('/config', jsonZodValidator(() => setConfigSchema), async (c) => {
      const { root: repoRoot, dataDir } = c.get('project');
      const parsed = { data: c.req.valid('json') };
      const configPath = join(dataDir, 'config.json');
      let raw: Record<string, unknown> = {};
      try {
        const existing: unknown = JSON.parse(await readFile(configPath, 'utf8'));
        if (existing && typeof existing === 'object') raw = existing as Record<string, unknown>;
      } catch {
        // missing or malformed — start fresh
      }
      if (parsed.data.baseBranch !== undefined) {
        if (parsed.data.baseBranch === null) delete raw.baseBranch;
        else raw.baseBranch = parsed.data.baseBranch;
      }
      if (parsed.data.defaultRunner !== undefined) raw.defaultRunner = parsed.data.defaultRunner;
      if (parsed.data.systemPrompt !== undefined) {
        // '' and null both clear: an emptied textarea means "no extra prompt".
        if (parsed.data.systemPrompt === null || parsed.data.systemPrompt === '') {
          delete raw.systemPrompt;
        } else {
          raw.systemPrompt = parsed.data.systemPrompt;
        }
      }
      if (parsed.data.maxParallel !== undefined) raw.maxParallel = parsed.data.maxParallel;
      if (parsed.data.worktreeRetention !== undefined) {
        // null clears back to the default (10); a number (including 0 = unlimited)
        // is stored as-is.
        if (parsed.data.worktreeRetention === null) delete raw.worktreeRetention;
        else raw.worktreeRetention = parsed.data.worktreeRetention;
      }
      if (parsed.data.liveTitleUpdates !== undefined) {
        if (parsed.data.liveTitleUpdates === null) delete raw.liveTitleUpdates;
        else raw.liveTitleUpdates = parsed.data.liveTitleUpdates;
      }
      if (parsed.data.reviewGate !== undefined) {
        if (parsed.data.reviewGate === null) delete raw.reviewGate;
        else raw.reviewGate = parsed.data.reviewGate;
      }
      if (parsed.data.memoryLimitMb !== undefined) {
        // null or 0 both mean "no ceiling" — drop the key back to the default.
        if (parsed.data.memoryLimitMb === null || parsed.data.memoryLimitMb === 0) {
          delete raw.memoryLimitMb;
        } else {
          raw.memoryLimitMb = parsed.data.memoryLimitMb;
        }
      }
      if (parsed.data.defaultModels !== undefined) {
        // Per-runner merge, so setting codex's preset never clobbers claude's.
        const current =
          raw.defaultModels && typeof raw.defaultModels === 'object'
            ? { ...(raw.defaultModels as Record<string, unknown>) }
            : {};
        for (const [runner, model] of Object.entries(parsed.data.defaultModels)) {
          if (model === undefined) continue;
          if (model === null || model === '') delete current[runner];
          else current[runner] = model;
        }
        if (Object.keys(current).length === 0) delete raw.defaultModels;
        else raw.defaultModels = current;
      }
      try {
        await mkdir(dataDir, { recursive: true });
        await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
      // Pre-R6 answer shape ({baseBranch, defaultRunner}) + additive R6 fields.
      return c.json(configAnswer(await loadConfig(repoRoot)));
    });

  // Set/clear the agents' config knobs (Settings → Agents; the Repo tab's
  // base-branch picker). Merges into the RAW config.json so user keys
  // (skillsRepos…) survive and schema defaults are never materialized into
  // the file. All fields optional + additive: `null` (and `''` for the
  // R6 keys) clears a knob back to its default.
  const modelPresetSchema = z.string().trim().max(200).nullable().optional();
  const setConfigSchema = z.object({
    baseBranch: z.string().trim().min(1).max(200).nullable().optional(),
    defaultRunner: z.enum(['claude', 'codex', 'opencode']).optional(),
    systemPrompt: z.string().trim().max(20_000, 'must be at most 20000 characters').nullable().optional(),
    defaultModels: z
      .object({
        claude: modelPresetSchema,
        codex: modelPresetSchema,
        opencode: modelPresetSchema,
      })
      .optional(),
    // Concurrency + memory guard (Settings → Resources). maxParallel clamps to
    // the schema's 1–16; memoryLimitMb null/0 clears the ceiling.
    maxParallel: z.number().int().min(1).max(16).optional(),
    memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
    // Worktree retention count (Settings → Resources, #483). 0 = unlimited;
    // null clears the key back to the schema default (10). Unlike memoryLimitMb,
    // 0 is a meaningful value (unlimited), so it is stored, not treated as clear.
    worktreeRetention: z.number().int().min(0).max(1000).nullable().optional(),
    // Live title updates toggle (Settings → Agents): null clears the key back
    // to the env-default behavior.
    liveTitleUpdates: z.boolean().nullable().optional(),
    // Optional review gate toggle (Settings → Agents, #489): null clears the key
    // back to the env-default behavior (OFF).
    reviewGate: z.boolean().nullable().optional(),
  });
  const setAgentConfigSchema = z.object({
    content: z.string().max(2_000_000),
    version: z.string().nullable(),
  });

  // ---- chained family: agent-config (project-scoped) -----------------------
  // Agent config is project-scoped (spec #404, adapted to the multi-project
  // route seam from #521): handlers resolve the selected repo through the
  // same ProjectContext as every other mirrored route. Chained (not statements)
  // so `AppType` carries it — see `healthRoutes`.
  const agentConfigRoutes = new Hono<ProjectApiEnv>()
    .get('/agent-config', async (c) => {
      const editable = capabilities().localHandoff;
      return c.json(await listAgentConfig(c.get('project').root, process.env, editable));
    })

    .get('/agent-config/:id', async (c) => {
      const id = c.req.param('id');
      const def = findConfigFile(id);
      if (!def) return c.json({ error: 'unknown config file' }, 404);
      if (def.tracked === 'outside-repo' && !capabilities().localHandoff) {
        return c.json(
          {
            error: 'this file lives in your home directory and is not served in hosted mode (CEZ_REMOTE)',
          },
          409,
        );
      }
      const read = await readConfigFile(id, c.get('project').root);
      if (read === null) return c.json({ error: 'unknown config file' }, 404);
      if ('error' in read) return c.json({ error: read.error }, 500);
      return c.json(read);
    })

    .put('/agent-config/:id', jsonZodValidator(setAgentConfigSchema), async (c) => {
      // Config files may define hooks and MCP commands, so writes remain a
      // local-machine capability and are re-gated on every request.
      if (!capabilities().localHandoff) {
        return c.json(
          {
            error:
              'editing agent config is disabled in hosted mode (CEZ_REMOTE) — edit it from the machine that owns the checkout',
          },
          409,
        );
      }
      const parsed = { data: c.req.valid('json') };
      const out = await writeConfigFile(
        c.req.param('id'),
        parsed.data.content,
        parsed.data.version,
        c.get('project').root,
      );
      if (out === null) return c.json({ error: 'unknown config file' }, 404);
      if (!out.ok) return c.json({ error: out.error }, out.status);
      return c.json(out.read);
    });

  // Repo view branch actions: switch to an existing branch, or create one
  // (from `from` or HEAD) and switch. Predictable git failures — invalid
  // name, unknown `from`, dirty-tree checkout conflict — are 409 + reason.
  const repoBranchSchema = z.object({
    name: z.string().trim().min(1).max(200),
    from: z.string().trim().min(1).max(200).optional(),
  });
  // ---- assemble the chained families --------------------------------------
  // Every chained family is registered ONCE and mounted into the versioned table. There is no
  // second, unversioned spelling: `/api/*` was removed once the whole API was reachable under
  // `/api/v1` (BACKWARD_COMPATIBILITY.md §2). One surface means one thing to keep working, and
  // it is the one the typed client describes.
  //
  // MOUNT ORDER IS REGISTRATION ORDER. Hono matches in the order routes were added, so each
  // family keeps its internal order and the families keep theirs relative to each other.
  //
  // Written as ONE chained expression because that is the only shape Hono can infer route types
  // from — it is what puts these routes in `AppType`, and so in the typed client.
  const v1 = new Hono<ProjectApiEnv>()
    .use('*', resolveProjectScope)
    .route('/', launchKeyRoutes)
    .route('/', skillsRoutes)
    .route('/', uiStateRoutes)
    .route('/', workflowsRoutes)
    .route('/', planRoutes)
    .route('/', automationsRoutes)
    .route('/', runsRoutes)
    .route('/', groupsRoutes)
    .route('/', openTargetsRoutes)
    .route('/', worktreesRoutes)
    .route('/', todosRoutes)
    .route('/', sseRoutes)
    .route('/', githubRoutes)
    .route('/', repoRoutes)
    .route('/', configRoutes)
    .route('/', agentConfigRoutes);

  // Workspace-level families answer for the whole workspace, so they are single-mount: never a
  // project-scoped spelling, which would be a second surface to protect with no consumer.
  const workspaceV1 = new Hono()
    .route('/', healthRoutes)
    .route('/', modelsRoutes)
    .route('/', providersRoutes)
    .route('/', projectsRoutes)
    .route('/', skillsUpdateRoutes)
    .route('/', workspaceConfigRoutes)
    .route('/', fsBrowseRoutes)
    .route('/', automationChecksRoutes)
    .route('/', workspaceEventsRoutes);

  // ---- mount ---------------------------------------------------------------
  // Scoped first, then the unscoped alias bound to the boot project. The paths are disjoint (no
  // route starts with `/p/`), so order between the two never decides a match — but the SPA
  // catch-all below must still come last. `route()` re-registers the sub-app's routes under
  // each prefix, handlers shared, internal order preserved.
  //
  // Workspace families mount LAST and that is load-bearing: mounting the project table also
  // mounts its `use('*')` scope resolver over the whole prefix, and Hono runs matched middleware
  // in registration order. `/health` in particular answers for the workspace, has no project to
  // resolve, and is the CORS-open discovery route — it must not sit behind the resolver.
  const routed = app
    .route(V1_SCOPED_PREFIX, v1)
    .route(V1_PREFIX, v1)
    .route(V1_PREFIX, workspaceV1);

  // ---- SPA catch-all -------------------------------------------------------
  // Last, so every route above still wins. Any other GET gets the cockpit shell:
  // react-router owns the route map, including the 404, so `/tasks/:id/changes`
  // cold-loads and survives a refresh instead of 404ing. `/api/*` and the static
  // files above resolve to `passthrough` and fall through to Hono's own 404 —
  // an unknown API path must never answer with HTML.
  // Without a web/dist build this serves the built-in build-hint page (dev-only
  // state — the published tarball ships web/dist), never a 404.
  routed.get('*', (c) => serveShell(c) ?? c.notFound());

  return routed;
}

export function startServer(deps: ServerDeps, port: number): ServerType {
  const workspaceEvents = deps.workspaceEvents ?? new WorkspaceEventBus();
  const skillsUpdate = deps.skillsUpdate ?? new SkillsUpdateService({ invalidateCatalog: refreshTeamSkills });
  // The subscription hub rides the same HTTP server (one port, zero config):
  // createApp registers the topics, the `upgrade` hook below owns the socket.
  const socketHub = deps.socketHub ?? createSocketHub();
  const automationCoordinator = new AutomationCoordinator({ listProjects });
  const bootProjectId = deps.bootProjectId ?? 'default';
  const bootAutomationStore = automationCoordinator.store(bootProjectId, deps.repoRoot)!;
  const sharedContexts = deps.contexts ?? new ProjectContexts({
    listProjects,
    semaphore: deps.semaphore,
    automationStore: (projectId, root) => automationCoordinator.store(projectId, root)!,
  });
  let rescheduleAutomations = () => {};
  const app = createApp({
    ...deps,
    contexts: sharedContexts,
    automationStore: bootAutomationStore,
    workspaceEvents,
    skillsUpdate,
    socketHub,
    automationsChanged: () => rescheduleAutomations(),
  });
  // SECURITY: default to loopback. This server executes agents locally and its endpoints are
  // same-origin-trusted (only /api/health is CORS-open); binding to a non-loopback host would
  // expose an agent-executing box to the network. `bindHost` exists only for a deliberate
  // hosted/VPS deployment (which also flips CEZ_REMOTE to gate the local-handoff endpoints) —
  // src/index.ts never passes it, so the loopback guarantee holds for the normal CLI.
  const server = serve({
    fetch: app.fetch,
    port,
    hostname: deps.bindHost ?? '127.0.0.1',
  });
  const coordinator = new SkillsUpdateCoordinator(skillsUpdate, async () =>
    effectiveSkillsAutoUpdate(await loadWorkspaceConfig()));
  const automationProjects = new Map<string, { root: string; owner: string; repo: string }>();
  const automationScheduler = new WorkspaceAutomationScheduler({
    coordinator: automationCoordinator,
    handle: (projectId, store) => {
      const project = automationProjects.get(projectId);
      if (!project) return undefined;
      return {
        projectId,
        owner: project.owner,
        repo: project.repo,
        store,
        poller: new GithubPoller(),
        onChange: (automationId, revision) =>
          workspaceEvents.emit('automation-change', { project: projectId, automationId, revision }),
        launch: async (definition, candidate, receiptId) => {
          const bootId = deps.bootProjectId ?? 'default';
          const context = projectId === bootId
            ? { root: deps.repoRoot, manager: deps.manager, store: deps.store }
            : await sharedContexts.context(projectId);
          return launchAutomationRun({
            root: context.root,
            manager: context.manager,
            store: context.store,
            definition,
            candidate,
            receiptId,
          });
        },
      };
    },
  });
  rescheduleAutomations = () => { void automationScheduler.reschedule(); };
  const unsubscribe = workspaceEvents.on((event, data) => {
    if (event === 'project-added') {
      const project = (data as { project?: { id?: unknown; root?: unknown; status?: unknown } }).project;
      if (project && typeof project.id === 'string' && typeof project.root === 'string' && project.status !== 'missing') {
        coordinator.add(project.id, project.root);
        void getRepoInfo(project.root).then((info) => {
          const parsed = parseRemote(info?.remote ?? '');
          if (parsed?.host === 'github.com') automationProjects.set(project.id as string, { root: project.root as string, owner: parsed.owner, repo: parsed.repo });
          return automationScheduler.reschedule();
        });
      }
    } else if (event === 'project-removed') {
      const id = (data as { id?: unknown }).id;
      if (typeof id === 'string') coordinator.remove(id);
      if (typeof id === 'string') {
        automationCoordinator.remove(id);
        automationProjects.delete(id);
        void automationScheduler.reschedule();
      }
    }
  });
  server.once('listening', () => {
    void listProjects().then((projects) => {
      const all = projects.some((project) => project.root === deps.repoRoot)
        ? projects : [{ id: deps.bootProjectId ?? 'default', root: deps.repoRoot, status: 'ok' as const }, ...projects];
      coordinator.start(all);
      void Promise.all(all.map(async (project) => {
        const parsed = parseRemote((await getRepoInfo(project.root))?.remote ?? '');
        if (parsed?.host === 'github.com') automationProjects.set(project.id, { root: project.root, owner: parsed.owner, repo: parsed.repo });
        const automationStore = automationCoordinator.store(project.id, project.root);
        const runStore = project.id === (deps.bootProjectId ?? 'default')
          ? deps.store
          : sharedContexts.peek(project.id)?.store;
        if (automationStore && runStore) reconcileAutomationReceipts(automationStore, runStore);
      })).then(() => automationScheduler.start()).catch(() => undefined);
    }).catch(() => undefined);
  });
  server.once('close', () => { unsubscribe(); coordinator.stop(); automationScheduler.stop(); });
  socketHub.attach(server, (req) => verifyWsUpgrade(req, deps.bindHost));
  return server;
}

/**
 * The WebSocket twin of the `/api/*` request-origin guard (#426), applied
 * before the `/api/v1/ws` handshake. WebSocket is NOT subject to CORS — any web
 * page may open `ws://127.0.0.1:<port>/api/v1/ws` and, unlike a forced HTTP GET,
 * would get to READ what comes back — so this guard is load-bearing:
 *
 *   1. Host allowlist (local mode): a non-loopback Host is a DNS-rebound
 *      request; kill it before the handshake. Same anchored
 *      `isLoopbackHostHeader` rules as the HTTP guard.
 *   2. Origin check: browsers always attach `Origin` to a WS handshake. A
 *      same-authority Origin is the cockpit itself. A LOOPBACK origin with a
 *      loopback Host is also admitted — that is the `npm run dev` Vite proxy
 *      (`changeOrigin` rewrites Host, the browser's `localhost:5173` Origin
 *      survives). Unlike the HTTP write guard we cannot REQUIRE `Sec-Fetch-Site`
 *      here — Safari sends no `Sec-Fetch-*` at all and requiring it would lock
 *      the dev proxy out of it — but we do honor it when it is there: Chromium
 *      does send it on a WS handshake, and page JS cannot forge it (forbidden
 *      header name), so a cross-port attacker page announcing `same-site` is
 *      rejected on the browser that ships it while Safari/Firefox still fall
 *      back to the loopback rule. Best available, not fail-open.
 *      No Origin at all is a non-browser client — same stance as the HTTP guard.
 *
 * The loopback-origin fallback still admits, on a browser that sends no
 * `Sec-Fetch-Site`, a page served from ANOTHER loopback port. That is no longer
 * a caveat the caller must remember: the verdict carries a `trusted` flag, and
 * the hub only lets an UNtrusted connection subscribe to topics a publisher
 * marked `loopbackReadable`. `health` is flagged so (the CORS-open discovery
 * payload, #431); every other topic stays trusted-only by default, so a topic
 * carrying run or repo content is mechanically unreachable from a foreign local
 * page without any per-topic vigilance. A connection is `trusted` when it is
 * provably the cockpit itself: a same-authority Origin, a no-Origin native
 * client, or a dev proxy the browser vouches for via `Sec-Fetch-Site`.
 */
export function verifyWsUpgrade(req: IncomingMessage, bindHost?: string): WsUpgradeVerdict {
  const host = req.headers.host;
  const hostName = hostnameOfHost(host);
  const hosted = !resolveCapabilities(process.env, bindHost).localHandoff;
  if (!hosted && !isLoopbackHostHeader(hostName)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return { trusted: true }; // non-browser client — no Origin to spoof
  // Scheme-checked, like the HTTP guard's comparison: `authorityOfOrigin` is
  // null for anything that is not an http(s) URL, so the opaque `"null"` origin
  // of a sandboxed iframe AND a `ftp://127.0.0.1`-shaped one both stay out
  // rather than reaching the loopback test below on hostname alone.
  const originAuthority = authorityOfOrigin(origin);
  const originHost = hostnameOfOrigin(origin);
  if (originAuthority === null || !originHost) return false;
  if (originAuthority === authorityOfHost(host)) return { trusted: true }; // the cockpit itself
  // The dev-proxy fallback. An explicit `cross-site`/`same-site` is an attacker
  // page on another local port and is refused even though both ends are
  // loopback; anything else needs loopback on both ends to get in at all.
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  if (!isLoopbackHostHeader(originHost) || !isLoopbackHostHeader(hostName)) return false;
  // Loopback on both ends, admitted. If the browser vouches it is same-origin
  // (`Sec-Fetch-Site: same-origin`, unforgeable by page JS), this is the dev
  // proxy on Chromium → trust it. An ABSENT header is a browser that ships no
  // metadata (Safari/Firefox), where the dev proxy and a foreign local page are
  // indistinguishable: admit as UNTRUSTED so only `loopbackReadable` topics show.
  return { trusted: fetchSite === 'same-origin' };
}

/** The bare hostname of a `Host` header — see `normalizeHostname`. `''` when the
 *  header is absent, which no allowlist matches. */
function hostnameOfHost(host: string | undefined): string {
  return host ? normalizeHostname(host) : '';
}

/** The `hostname:port` authority of a `Host` header, e.g. `127.0.0.1:4321`.
 *
 *  The port is kept verbatim and is `''` when the header omits it — which is
 *  exactly when a browser also omits it from `Origin` (both drop the scheme's
 *  default port). That symmetry is what lets us compare the two without knowing
 *  our own scheme, which we cannot know behind a TLS-terminating proxy. */
function authorityOfHost(host: string | undefined): string {
  if (!host) return '';
  const port = host.match(/^\[[^\]]*\]:(\d+)$/)?.[1] ?? host.match(/^[^:]*:(\d+)$/)?.[1] ?? '';
  return `${normalizeHostname(host)}:${port}`;
}

/** The `hostname:port` authority of an `Origin` header, or `null` when it is not
 *  a parseable http(s) URL (the opaque `"null"` origin of a sandboxed iframe, a
 *  `file://` page). `URL.port` is `''` for a scheme's default port, matching
 *  `authorityOfHost`. */
function authorityOfOrigin(origin: string): string | null {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${normalizeHostname(u.hostname)}:${u.port}`;
  } catch {
    return null;
  }
}

/** The hostname of an `Origin` header, or `null` when it is not a parseable URL
 *  (e.g. the opaque `"null"` origin of a sandboxed iframe). Normalized through
 *  the same path as `hostnameOfHost` so the two compare equal for IPv6 and for
 *  trailing-dot FQDNs. */
function hostnameOfOrigin(origin: string): string | null {
  try {
    return normalizeHostname(new URL(origin).hostname);
  } catch {
    return null;
  }
}

function resolveWebDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/server (built) or <pkg>/src/server (tsx dev).
  return join(here, '..', '..', 'web');
}

/**
 * The session id shape every backend actually mints: UUIDs (claude/codex) and
 * the CLIs' own slug-ish ids. No character here is special to bash, AppleScript
 * OR cmd.exe, and a leading `-` is refused so the id can never be read as an
 * option by the CLI it is passed to (same dash-guard as `isSafeGitRef`, #431).
 * Bounded, like every other input that reaches a spawned process.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,199}$/;

/** True for session ids safe to splice into the take-over command (see above). */
export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/**
 * The CLI command that reopens a run's session for interactive take-over, per
 * backend. Legacy/undefined records default to Claude. Returns null when the id
 * is not a shape we recognise — callers degrade (no take-over) rather than
 * splice it into a shell.
 *
 * Validate, don't quote (#431): the session id is the only variable spliced
 * into the command string, and `openInTerminal` runs that string through bash
 * on darwin/linux but through `cmd /K` on win32. cmd.exe does not treat `'` as
 * a quote character, so POSIX-quoting the id handed Windows users a literal
 * `claude --resume '9f8e…'` and Claude answered "no conversation found".
 * Constraining the charset to one with no metacharacter in ANY of those shells
 * needs no quoting at all and fails closed on an unexpected id — a stronger
 * guarantee than escaping, and platform-independent. Ids are UUID/CLI-minted
 * today; this keeps a future source safe.
 */
export function resumeCommand(runner: string | undefined, sessionId: string): string | null {
  if (!isSafeSessionId(sessionId)) return null;
  switch (runner) {
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'opencode':
      return `opencode --session ${sessionId}`;
    default:
      return `claude --resume ${sessionId}`;
  }
}
