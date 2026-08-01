import { z } from 'zod';
import { type Runner, runnerSchema } from './health.ts';

/**
 * The workspace + settings families: `~/.cezar/config.json`'s settings slice, both GUI-pref bags
 * (per-repo and workspace), the per-repo agent knobs, provider auth status, the host model
 * catalog, the skills-update state, and the "Open in…" targets.
 *
 * Node-free by construction (see README rule 1) — `zod` and the sibling contract modules only.
 */

// ---- workspace settings (`GET/PUT /api/v1/workspace/config`) --------------------------------

/**
 * `GET/PUT /api/v1/workspace/config` — the settings slice of `~/.cezar/config.json` (step 2.7).
 *
 * Global knobs only: the registry itself is `GET /api/v1/projects`, and `schemaVersion` (a
 * migration cursor, not a setting) is deliberately absent. `resources` is the workspace's
 * host-protection budget — the ONLY effective `maxParallel`/`memoryLimitMb` since Phase 2;
 * `worktreeRetentionDefault` seeds projects that set none.
 *
 * `composerDefaults` and every `resources` key are REQUIRED: `workspaceConfigBody`
 * (src/server/server.ts:1888) materializes all of them from schema defaults on every answer,
 * including the degraded path. The hand-written DTO declared `composerDefaults`,
 * `resources.maxMonitoringSessions` and `resources.monitoringWakeIntervalMinutes` optional, which
 * was wider than the server has ever been.
 */
export const workspaceConfigResponseSchema = z.object({
  /** Root exposed by the Add-project directory browser — stored as written (`~` kept). */
  browseRoot: z.string(),
  /** Checkout root for GUI-cloned projects — stored as written (`~` kept). */
  projectsDir: z.string(),
  /** Stored override; `null` means inherit `CEZ_SKILLS_AUTO_UPDATE`, then true. */
  skillsAutoUpdate: z.boolean().nullable(),
  effectiveSkillsAutoUpdate: z.boolean(),
  composerDefaults: z.object({
    autonomous: z.boolean().nullable(),
    worktree: z.boolean().nullable(),
    /** `'source-dependent'` when no `CEZ_AUTONOMOUS_DEFAULT` pins it either way. */
    inheritedAutonomous: z.union([z.boolean(), z.literal('source-dependent')]),
    inheritedWorktree: z.boolean(),
  }),
  resources: z.object({
    maxParallel: z.number(),
    maxMonitoringSessions: z.number(),
    monitoringWakeIntervalMinutes: z.number().nullable(),
    memoryLimitMb: z.number().nullable(),
    worktreeRetentionDefault: z.number(),
  }),
  /**
   * What a repo that has set none of its own runs (spec 2026-07-29-agent-profiles).
   *
   * Both keys are OPTIONAL on the wire, and that is load-bearing rather than lax: absent means
   * "this machine has no opinion, the built-in default applies", and it has to stay distinguishable
   * from a value someone chose or the fallback collapses into "always claude". Consulted only where
   * the repo's own `.ai/cezar/config.json` is silent — a repo that chose is never overruled.
   */
  agentDefaults: z.object({
    runner: runnerSchema.optional(),
    models: z.object({
      claude: z.string().optional(),
      codex: z.string().optional(),
      opencode: z.string().optional(),
    }).optional(),
  }),
});
export type WorkspaceConfigResponse = z.infer<typeof workspaceConfigResponseSchema>;

/**
 * `PUT /api/v1/workspace/config` body — partial: absent keys stay untouched. A rejected workspace
 * root (not writable) 400s with the reason and persists NOTHING, resources included, so callers
 * may send both in one request only if they want that atomicity. Bounds mirror
 * `src/workspace/config.ts` exactly, so a value this schema accepts can never be degraded away by
 * the next load's `.catch`.
 */
export const setWorkspaceConfigInputSchema = z.object({
  browseRoot: z.string().trim().min(1).max(4096).optional(),
  projectsDir: z.string().trim().min(1).max(4096).optional(),
  skillsAutoUpdate: z.boolean().nullable().optional(),
  composerDefaults: z
    .object({
      autonomous: z.boolean().nullable().optional(),
      worktree: z.boolean().nullable().optional(),
    })
    .optional(),
  /** Machine-wide agent defaults. `null` on a key CLEARS it back to "no opinion", which a bare
   *  absent key cannot say in a partial patch. */
  agentDefaults: z
    .object({
      runner: runnerSchema.nullable().optional(),
      models: z
        .object({
          claude: z.string().trim().min(1).max(200).nullable().optional(),
          codex: z.string().trim().min(1).max(200).nullable().optional(),
          opencode: z.string().trim().min(1).max(200).nullable().optional(),
        })
        .optional(),
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
export type SetWorkspaceConfigInput = z.infer<typeof setWorkspaceConfigInputSchema>;

// ---- GUI prefs — the two open bags ----------------------------------------------------------

/** Settings → Appearance: accent + density. ONE shape for both ui-state files. */
const appearanceSchema = z.object({
  accent: z.enum(['lime', 'violet']).optional(),
  density: z.enum(['comfortable', 'compact', 'ultra']).optional(),
});

/**
 * `GET/PUT /api/v1/ui-state` — the per-repo GUI prefs in `.ai/cezar/ui-state.json`.
 *
 * An OPEN bag on purpose (BACKWARD_COMPATIBILITY.md §3): unknown keys round-trip untouched, so a
 * newer cockpit's prefs survive an older server and a future pref needs no server change. Hence
 * `z.looseObject`, not a closed object — the keys below are the ones the server's schema *names*,
 * never the ones it *permits*. The write side caps the TOP-LEVEL key count at 200 (#429); that cap
 * is a request-body refinement in `src/server/server.ts` (`capUiStateKeys`, :756) and is not part
 * of the response shape.
 *
 * `notifications` is deliberately NOT here: it moved to `WorkspaceUiState` at step 3.5 and the
 * per-repo schema (src/server/server.ts:550) has not named it since. The hand-written DTO still
 * listed it, which made it wider than the route.
 */
export const uiStateSchema = z.looseObject({
  lastTask: z
    .object({ source: z.enum(['workflow', 'skill']), ref: z.string() })
    .optional(),
  /** Most-recently-run sources, newest first (deduped, capped). Feeds the composer picker's
   *  recency sort. */
  recentSources: z
    .array(z.object({ source: z.enum(['workflow', 'skill']), ref: z.string() }))
    .optional(),
  /** The last worktree choice for a single-skill run. Absent → the default (isolated worktree). */
  lastWorktree: z.boolean().optional(),
  /** The last autonomous choice — remembered like `lastWorktree`. Absent → off. */
  lastAutonomous: z.boolean().optional(),
  /** Whether new runs should ask agents to append follow-up work. Absent → on. */
  lastGenerateFollowups: z.boolean().optional(),
  /** Skill selection frequency (#408): name → times chosen, across BOTH composers. */
  skillUsage: z.record(z.string(), z.number()).optional(),
  runsView: z.enum(['list', 'table']).optional(),
  /** The GitHub tab's last-selected sub-tab (#417). Absent → issues. */
  githubView: z.enum(['issues', 'prs']).optional(),
  /** Settings → Appearance. The theme itself stays in localStorage (`cez-theme`) — it must
   *  pre-paint, and it is per-browser by design. */
  appearance: appearanceSchema.optional(),
  /** Follow-up prompt templates (#413). Absent → the built-in defaults; present (even `[]`) is
   *  the user's own edited list. `skills` are the skill names the template auto-applies for. */
  promptTemplates: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        text: z.string(),
        skills: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  /** The open-mercato/skills promo banner (#391), dismissed for good. Legacy — the banner is
   *  gone, replaced by `WorkspaceUiState.importedSkills`; retained so old files round-trip. */
  dismissedSkillsBanner: z.boolean().optional(),
});
export type UiState = z.infer<typeof uiStateSchema>;

/**
 * `GET/PUT /api/v1/workspace/ui-state` — cross-project GUI prefs in `~/.cezar/ui-state.json`
 * (multi-project spec, step 2.7).
 *
 * The same open bag as its per-repo twin above, and open for the same reason. The PUT merges
 * SHALLOWLY at the top level server-side, so a writer must send the whole `sidebar` object (or the
 * whole `importedSkills` array), never a leaf.
 */
export const workspaceLastLocationSchema = z.strictObject({
  projectId: z.string().min(1).max(64),
  pathname: z.string().min(1).max(2048).startsWith('/p/'),
  search: z.string().max(4096).startsWith('?').optional(),
  hash: z.string().max(2048).startsWith('#').optional(),
});
export type WorkspaceLastLocation = z.infer<typeof workspaceLastLocationSchema>;

export const workspaceUiStateSchema = z.looseObject({
  /** The sidebar's per-project collapse map (step 3.3) — `true` collapses a group, `false` pins
   *  it open, absent means the default (the active project expands, the rest collapse). Loose for
   *  the same round-trip reason as its parent. */
  sidebar: z
    .looseObject({ collapsed: z.record(z.string(), z.boolean()).optional() })
    .optional(),
  /** Dismissed runtime-auth incident IDs, keyed by provider. An ID is only dismissed until the
   *  provider reports a different incident, so this stays workspace-global with the browser
   *  rather than one project checkout. */
  dismissedProviderAuthFailures: z
    .object({
      claude: z.string().optional(),
      codex: z.string().optional(),
      opencode: z.string().optional(),
    })
    .optional(),
  /** Settings → Appearance, GLOBAL since step 3.5: accent + density describe the person at the
   *  keyboard, not a repo. */
  appearance: appearanceSchema.optional(),
  /** Settings → Notifications, GLOBAL since step 3.5 — one answer for the whole workspace, since
   *  the delivering browser is one browser whichever project you are looking at. */
  notifications: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  /** Last settled project-scoped page. Used only when entering at the exact bare root;
   *  explicit deep links always win. */
  lastLocation: workspaceLastLocationSchema.optional(),
  /** The user's curated selection of default (vendor) skills. Tri-state: ABSENT means "not
   *  curated", so every default skill shows; a PRESENT array (even `[]`) means only those names
   *  show from that repo. */
  importedSkills: z.array(z.string()).optional(),
});
export type WorkspaceUiState = z.infer<typeof workspaceUiStateSchema>;

// ---- per-repo agent knobs (`GET/PUT /api/v1/config`) ----------------------------------------

/** Per-runner default model preset (Settings → Agents): the composer preselects this model id for
 *  the runner. Absent = auto (the runner decides). Keyed by runner name rather than derived from
 *  `runnerSchema` because the server's own `defaultModels` object (src/config.ts:92) is spelled
 *  the same way — one key per runner, each independently optional. */
export const runnerModelsSchema = z.object({
  claude: z.string().optional(),
  codex: z.string().optional(),
  opencode: z.string().optional(),
});
export type RunnerModels = z.infer<typeof runnerModelsSchema>;

/** `GET /api/v1/config` — every Settings → Agents knob in one read. */
export const configResponseSchema = z.object({
  baseBranch: z.string().nullable(),
  defaultRunner: runnerSchema,
  systemPrompt: z.string().nullable(),
  defaultModels: runnerModelsSchema,
  /** True when native coding-agent settings are authoritative and model picks are read-only. */
  modelsLocked: z.boolean(),
  /** How many tasks run at once (1–16). */
  maxParallel: z.number(),
  /** Per-task memory ceiling in MiB (whole process tree); null = no limit. */
  memoryLimitMb: z.number().nullable(),
  /** Keep the last N finished worktrees on disk (#483); 0 = unlimited. Older ones are reclaimed
   *  (directory only — branch kept, so work is recoverable). */
  worktreeRetention: z.number(),
  /** Live title updates: null = no config key, the `CEZ_TITLE_UPDATES` env default (ON) decides. */
  liveTitleUpdates: z.boolean().nullable(),
  /** Optional review gate (#489): null = no config key, the `CEZ_REVIEW_GATE` env default (OFF)
   *  decides. */
  reviewGate: z.boolean().nullable(),
});
export type ConfigResponse = z.infer<typeof configResponseSchema>;

/** The `PUT /api/v1/config` answer: the same shape GET serves (`configAnswer` builds both). */
export const setConfigResponseSchema = configResponseSchema;
export type SetConfigResponse = z.infer<typeof setConfigResponseSchema>;

/**
 * `PUT /api/v1/config` body (Settings → Agents; the Repo tab's base-branch picker).
 * `baseBranch: null` clears the setting back to "follow checked-out branch"; `systemPrompt` and
 * per-runner `defaultModels` entries clear on `null` (or `''`) too. Merged into the raw
 * config.json server-side — `defaultModels` merges per runner, so one write never clobbers
 * another runner's preset.
 */
export const setConfigInputSchema = z.object({
  baseBranch: z.string().trim().min(1).max(200).nullable().optional(),
  defaultRunner: runnerSchema.optional(),
  systemPrompt: z.string().trim().max(20_000).nullable().optional(),
  defaultModels: z
    .object({
      claude: z.string().trim().max(200).nullable().optional(),
      codex: z.string().trim().max(200).nullable().optional(),
      opencode: z.string().trim().max(200).nullable().optional(),
    })
    .optional(),
  maxParallel: z.number().int().min(1).max(16).optional(),
  /** null or 0 clears the ceiling back to "no limit". */
  memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().optional(),
  /** Keep last N finished worktrees (#483); 0 = unlimited, null clears back to the default (10). */
  worktreeRetention: z.number().int().min(0).max(1000).nullable().optional(),
  /** null clears the key back to the env-default behavior. */
  liveTitleUpdates: z.boolean().nullable().optional(),
  /** null clears the key back to the env-default behavior (OFF). */
  reviewGate: z.boolean().nullable().optional(),
});
export type SetConfigInput = z.infer<typeof setConfigInputSchema>;

// ---- skills updates (`/api/v1/workspace/skills-update`) --------------------------------------

export const skillsUpdateStatusSchema = z.enum([
  'idle',
  'checking',
  'available',
  'updating',
  'current',
  'unavailable',
  'error',
]);
export type SkillsUpdateStatus = z.infer<typeof skillsUpdateStatusSchema>;

export const skillsUpdateScopeStateSchema = z.object({
  scope: z.enum(['project', 'global']),
  status: skillsUpdateStatusSchema,
  available: z.boolean(),
  skills: z.array(z.string()),
  checkedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  reason: z.string().optional(),
});
export type SkillsUpdateScopeState = z.infer<typeof skillsUpdateScopeStateSchema>;

/** `GET /api/v1/workspace/skills-update` (and the check/apply POSTs) — the merged project+global
 *  skills-update state. `autoUpdateEnabled`/`inherited` are re-stamped from the workspace config
 *  on the way out (`skillsUpdateResponse`, src/server/server.ts:1818). */
export const skillsUpdateStateSchema = z.object({
  status: skillsUpdateStatusSchema,
  available: z.boolean(),
  autoUpdateEnabled: z.boolean(),
  inherited: z.boolean(),
  checkedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  scopes: z.array(skillsUpdateScopeStateSchema),
  needsUpgradeNotes: z.boolean(),
});
export type SkillsUpdateState = z.infer<typeof skillsUpdateStateSchema>;

// ---- provider auth (`/api/v1/providers/*`) ---------------------------------------------------

/** The agent backends are the providers — one alias, never a second enum. */
export const providerIdSchema = runnerSchema;
export type ProviderId = Runner;

/** Coarse host authentication state. Credentials, account identity, and raw CLI output never
 *  cross this boundary. */
export const providerConnectionStateSchema = z.enum([
  'connected',
  'disconnected',
  'not-installed',
  'unknown',
]);
export type ProviderConnectionState = z.infer<typeof providerConnectionStateSchema>;

/**
 * One provider row.
 *
 * `enabled` is OPTIONAL: `ProviderAuth.status()` (src/core/provider-auth.ts:12) builds rows
 * without it and only `applyProviderEnablement` stamps it in, so the type the routes answer keeps
 * the key optional. The hand-written DTO declared it required — narrower than the route.
 */
export const providerStatusSchema = z.object({
  provider: providerIdSchema,
  status: providerConnectionStateSchema,
  enabled: z.boolean().optional(),
  hint: z.string().optional(),
  authFailureId: z.string().optional(),
  /** Which agent account this row describes (spec 2026-07-29-agent-profiles). ABSENT on
   *  `GET /api/v1/providers/status`, which deliberately keeps answering exactly one row per
   *  provider — the discovered default — so an older client sees no change at all. Per-account
   *  rows are carried by `GET /api/v1/workspace/agent-profiles` instead. */
  profileId: z.string().optional(),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

/** `GET /api/v1/providers/status`, and the answer of the enabled/retry mutators. */
export const providerStatusResponseSchema = z.object({
  providers: z.array(providerStatusSchema),
});
export type ProviderStatusResponse = z.infer<typeof providerStatusResponseSchema>;

/** `POST /api/v1/providers/connect` — either a terminal was handed the login command, or the
 *  provider turned out to be connected already. Every other outcome is a 409/500 carrying the
 *  same `command` for the clipboard fallback. */
export const providerConnectResponseSchema = z.discriminatedUnion('opened', [
  z.object({ opened: z.literal(true), command: z.string() }),
  z.object({ opened: z.literal(false), connected: z.literal(true), command: z.string() }),
]);
export type ProviderConnectResponse = z.infer<typeof providerConnectResponseSchema>;

// ---- host model catalog (`GET /api/v1/models`) -----------------------------------------------

export const runnerModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});
export type RunnerModelOption = z.infer<typeof runnerModelOptionSchema>;

/** `GET /api/v1/models?runner=codex` — discovered models, plus how fresh the answer is. Never an
 *  error: an unavailable CLI degrades to `source: 'unavailable'` with a `reason`. */
export const runnerModelCatalogResponseSchema = z.object({
  runner: runnerSchema,
  models: z.array(runnerModelOptionSchema),
  source: z.enum(['live', 'cache', 'unavailable']),
  stale: z.boolean(),
  reason: z.string().optional(),
});
export type RunnerModelCatalogResponse = z.infer<typeof runnerModelCatalogResponseSchema>;

// ---- "Open in…" targets (`GET /api/v1/open-targets`) -----------------------------------------

/** A local app a worktree can be opened in (#open-in): editor, file manager, or terminal. */
export const openTargetSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** A stable icon key (#361) the UI maps to a concrete icon. Optional: an older server omitting
   *  it just renders the generic fallback icon. */
  icon: z.string().optional(),
});
export type OpenTarget = z.infer<typeof openTargetSchema>;

/** `GET /api/v1/open-targets` — the detected local apps; empty in hosted mode (CEZ_REMOTE). */
export const openTargetsResponseSchema = z.object({
  targets: z.array(openTargetSchema),
});
export type OpenTargetsResponse = z.infer<typeof openTargetsResponseSchema>;
