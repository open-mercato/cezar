import { z } from 'zod';

/** The agent backends a run can be dispatched to. */
export const runnerSchema = z.enum(['claude', 'codex', 'opencode', 'cursor', 'pi', 'junie', 'copilot']);
export type Runner = z.infer<typeof runnerSchema>;

/** Git facts about the project root, or `null` when it is not a repository. */
export const repoInfoSchema = z.object({
  root: z.string(),
  branch: z.string(),
  remote: z.string().optional(),
});
export type RepoInfo = z.infer<typeof repoInfoSchema>;

/** One probed CLI behind the Tools menu. */
export const backendCheckSchema = z.object({
  name: z.enum(['claude', 'codex', 'opencode', 'cursor', 'pi', 'junie', 'copilot', 'gh', 'git']),
  available: z.boolean(),
  version: z.string().optional(),
  hint: z.string().optional(),
});
export type BackendCheck = z.infer<typeof backendCheckSchema>;

export const forgeInfoSchema = z.object({
  kind: z.literal('github'),
  /**
   * Whether the forge is reachable — **absent until the availability probe has warmed**.
   *
   * Health must never pay a `gh` shell-out, so it serves whatever the cache holds. Absent means
   * "not determined yet", which is not the same as `false`, and the cockpit renders the two
   * differently. Declaring it required is what made an earlier hand-written mirror wrong.
   */
  available: z.boolean().optional(),
  reason: z.string().optional(),
});
export type ForgeInfo = z.infer<typeof forgeInfoSchema>;

/** Server-side feature switches the cockpit reads once at boot. */
export const capabilitiesSchema = z.object({
  localHandoff: z.boolean(),
  /** May this cockpit open an interactive terminal in a task worktree? Policy, not availability:
   *  the terminal family's own endpoint says whether the optional PTY binding loaded. */
  terminal: z.boolean(),
  /**
   * `true` means the task's Preview tab may offer Design Mode (spec
   * `.ai/specs/2026-10-09-design-mode.md`): click an element of the task's app and send a note
   * about it to the agent. It needs a second loopback listener that re-serves the app with a picker
   * injected, so it exists only on a LOCAL cockpit, and `CEZ_DESIGN_MODE=0` turns it off there too.
   */
  designMode: z.boolean(),
  followups: z.boolean(),
  singleProject: z.boolean(),
  /**
   * `true` means `CEZ_AUTOMATIONS=1` opted this server into GitHub automations (#801). Off — the
   * default — the whole feature is absent: no `Automations` nav item anywhere it is rendered, the
   * `/api/v1/…/automations*` family answers `409`, and the workspace scheduler never polls GitHub.
   *
   * REQUIRED for the same reason as `tokenMetrics` below: this server always sends it.
   */
  automations: z.boolean(),
  /** Project lifecycle notifications; independent of graph notify steps. */
  webhooks: z.boolean(),
  /** Present on unsupported server platforms, regardless of the opt-in flag. */
  webhooksUnavailableReason: z.literal('unsupported_platform').optional(),
  /**
   * `true` means task dispatch is on — the default; `CEZ_DISPATCH=0` turns it off (spec
   * `.ai/specs/2026-09-10-dispatch.md`): every task learns the `cez task` CLI in its system
   * prompt and the `/runs/:id/{dispatch,report}` routes answer. Off, those routes answer 409 and
   * no prompt mentions dispatching.
   */
  dispatch: z.boolean(),
  /**
   * `false` means `CEZ_HIDE_TOKEN_METRICS=1` asks the browser to omit token counts and monetary
   * cost (#481). The telemetry itself still rides in run/event payloads — this is presentation
   * only.
   *
   * REQUIRED, because this server always sends it (`capabilities.ts` computes it from the env on
   * every read) and this contract describes THIS server's wire. The DTO it replaces declared it
   * optional so a newer cockpit could read an OLDER server, which is version skew a contract
   * versioned in lockstep with the server cannot model. That tolerance lives where it belongs, in
   * `web/src/lib/token-metrics.ts`, whose `!== false` read still treats an absent field as
   * visible.
   */
  tokenMetrics: z.boolean(),
  /** Current token-count presentation policy. Required on current servers;
   * older payload tolerance belongs in the browser resolver. */
  tokenUsageMetrics: z.boolean(),
  /** Current backend-reported-cost presentation policy. */
  costMetrics: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * Free space on the volume holding the boot project's task worktrees (telemetry 9cdcedc3). No
 * path: health is CORS-open (#431). `critical` is the floor below which agents are refused at
 * spawn; `low` only warns. `worktreesBytes` is a cached `du` estimate, sent only once known.
 */
export const diskInfoSchema = z.object({
  freeBytes: z.number(),
  totalBytes: z.number(),
  level: z.enum(['ok', 'low', 'critical']),
  worktreesBytes: z.number().optional(),
});
export type DiskInfo = z.infer<typeof diskInfoSchema>;

/**
 * `GET /api/v1/health` — the CORS-open discovery endpoint (BACKWARD_COMPATIBILITY.md §2).
 *
 * Additive fields only: this is the most externally-depended-on JSON in the app.
 */
export const healthResponseSchema = z.object({
  version: z.string(),
  latestVersion: z.string().optional(),
  repoRoot: z.string(),
  repo: repoInfoSchema.nullable(),
  checks: z.array(backendCheckSchema),
  defaultRunner: runnerSchema,
  forge: forgeInfoSchema.nullable(),
  capabilities: capabilitiesSchema,
  // Always sent: `workspaceSummary()` returns both unconditionally, and an unreadable workspace
  // degrades to `projects: []` rather than to an absent key. The hand-written DTO declared them
  // optional, which was wider than the server has ever been.
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  bootProject: z.string(),
  /** Random identity of the installed service, when server-install supplied one. */
  instanceId: z.string().optional(),
  /** Absent where `statfs` is unavailable or fails. */
  disk: diskInfoSchema.optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
