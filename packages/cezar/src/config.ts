import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { loadWorkspaceConfig } from './workspace/config.ts';

/**
 * Optional advanced config at `.ai/cezar/config.json`. Zero-config rule:
 * a missing file behaves exactly like the default below, an unreadable or
 * invalid file degrades to the default too (never blocks startup). The key
 * can be overridden or emptied (`"skillsRepos": []` disables team skills).
 */
const skillsRepoSchema = z.object({
  /** `owner/name` (GitHub shorthand), a full git URL, or a local/file:// path. */
  repo: z.string().min(1),
  ref: z.string().min(1).default('main'),
});

export type SkillsRepoSource = z.infer<typeof skillsRepoSchema>;

export const DEFAULT_SKILLS_REPOS: SkillsRepoSource[] = [
  { repo: 'open-mercato/skills', ref: 'main' },
];

/** Last-resort retention when neither the repo nor the workspace says anything. */
export const DEFAULT_WORKTREE_RETENTION = 10;

/** Bounds for `worktreeRetention` — shared with the presence probe below, so the
 *  "does this repo set its own?" question is answered by the same rule the
 *  schema enforces (and mirrors the workspace default's bounds). */
const worktreeRetentionSchema = z.number().int().min(0).max(1000);

const configSchema = z.object({
  skillsRepos: z.array(skillsRepoSchema).default(DEFAULT_SKILLS_REPOS),
  /** How many tasks may run at once (spec 006). Non-git dirs always run 1. */
  maxParallel: z.number().int().min(1).max(16).default(2),
  /**
   * Count-based worktree retention (#483): keep the last N *finished*
   * worktrees materialized on disk; reclaim older ones (directory only — the
   * `cez/<id8>` branch is kept, so the work stays recoverable). 0 = unlimited
   * (never auto-reclaim). Default 10. `.catch(10)` keeps it additive-safe: a
   * bad value degrades to the default instead of discarding the rest.
   */
  worktreeRetention: worktreeRetentionSchema.default(DEFAULT_WORKTREE_RETENTION).catch(DEFAULT_WORKTREE_RETENTION),
  /**
   * Per-task memory ceiling in MiB (whole process tree). When a running task's
   * RSS crosses this the engine pauses it with a warning and lets the queue
   * advance (#memory-guard). 0 / unset = no limit. `.catch(undefined)` keeps
   * the key additive-safe: a bad value degrades to "no limit".
   */
  memoryLimitMb: z.number().int().min(0).max(1_048_576).optional().catch(undefined),
  /**
   * Which agent backend a task uses unless overridden per task (GUI) or per
   * step (workflow). The GUI only offers runners actually installed; this is
   * the preselected default. Also the runner the chain planner uses.
   */
  defaultRunner: z.enum(['claude', 'codex', 'opencode']).default('claude'),
  /** Model for the chain planner (spec 008) — cheap but reliable at JSON. */
  plannerModel: z.string().min(1).default('sonnet'),
  /** Model for the task namer (spec 2026-07-17-task-auto-naming) — the cheapest
   *  alias that answers strict JSON; naming is fire-and-forget and never blocks. */
  namerModel: z.string().min(1).default('haiku'),
  /** Live title updates: refresh the display title through the namer on each
   *  turn end. Absent = the `CEZ_TITLE_UPDATES` env decides (default ON — owner
   *  decision on PR #479). */
  liveTitleUpdates: z.boolean().optional(),
  /** Optional diff-first review gate (#489): when a successful run with changes
   *  should park at `review` for a human. Absent = the `CEZ_REVIEW_GATE` env
   *  decides (default OFF — the deliberate inverse of `liveTitleUpdates`).
   *  Autonomous runs always skip the gate regardless of this. */
  reviewGate: z.boolean().optional(),
  /**
   * Branch task worktrees fork from and draft PRs target (e.g. `develop`).
   * Unset = the branch currently checked out. Settable from the Repo tab.
   */
  baseBranch: z.string().trim().min(1).optional(),
  /**
   * Default extra system prompt applied to every run's agent steps (claude:
   * `--append-system-prompt`; codex/opencode: prepended to the opening user
   * message — the AgentRunSpec seam handles the per-backend delivery).
   * Settings is the single edit place; `POST /api/runs` can override it per
   * run (`systemPrompt`). `.catch(undefined)` keeps the key additive-safe: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  systemPrompt: z.string().trim().min(1).max(20_000).optional().catch(undefined),
  /**
   * Per-runner default model preset (Settings → Agents, redesign R6 1.5): the
   * model id the composer preselects for that runner. Missing = auto (the
   * runner decides). A capability (`model`), never a vendor config format.
   * `.catch(undefined)` keeps the key additive-safe like `systemPrompt`: a
   * bad value degrades to unset without discarding the rest of the config.
   */
  defaultModels: z
    .object({
      claude: z.string().trim().min(1).max(200).optional(),
      codex: z.string().trim().min(1).max(200).optional(),
      opencode: z.string().trim().min(1).max(200).optional(),
    })
    .optional()
    .catch(undefined),
  /**
   * Make each coding agent's native model setting authoritative. This is an
   * optional repo-level counterpart to `CEZ_AGENT_MODELS_LOCKED=1`; absent or
   * false preserves the ordinary per-runner model selector.
   */
  modelsLocked: z.boolean().optional().catch(undefined),
});

export type CezConfig = z.infer<typeof configSchema>;

/** Read `.ai/cezar/config.json` on demand — never cached, never throws. */
export async function loadConfig(repoRoot: string): Promise<CezConfig> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8');
  } catch {
    return configSchema.parse({});
  }
  try {
    const parsed = configSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through — malformed JSON degrades to the default
  }
  return configSchema.parse({});
}

/**
 * The repo's OWN `worktreeRetention`, or `undefined` when it doesn't set one.
 *
 * `loadConfig` cannot answer this: the schema's `.default(10).catch(10)`
 * materializes the key, so a parsed config can't tell "the user chose 10" from
 * "the user said nothing". So we probe the raw file — a key that is absent (or
 * carries a value the schema would refuse) means the repo has no opinion, and
 * the workspace default gets to seed it.
 */
async function ownWorktreeRetention(repoRoot: string): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8');
  } catch {
    return undefined; // no file — nothing set
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = (parsed as Record<string, unknown>).worktreeRetention;
    if (value === undefined) return undefined;
    const field = worktreeRetentionSchema.safeParse(value);
    return field.success ? field.data : undefined;
  } catch {
    return undefined; // malformed JSON — same as unset
  }
}

/**
 * The default skills repos that are *opt-in per skill* (the "import OM skills"
 * flow): the set of repo identifiers a user must explicitly import from before
 * their skills join the catalog. This is exactly `DEFAULT_SKILLS_REPOS` when the
 * repo has NOT configured its own `skillsRepos` — the zero-config majority — and
 * empty once a repo takes control by setting `skillsRepos` (then everything it
 * lists auto-loads, unchanged).
 *
 * `loadConfig` cannot answer this: the schema's `.default(DEFAULT_SKILLS_REPOS)`
 * materializes the key, so a parsed config can't tell "the user chose these" from
 * "the user said nothing". So we probe the raw file for the key's presence — the
 * same reason `ownWorktreeRetention` below reads the raw JSON.
 */
export async function gatedSkillsRepos(repoRoot: string): Promise<Set<string>> {
  const none = new Set<string>();
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, '.ai/cezar', 'config.json'), 'utf8');
  } catch {
    // No file — the defaults are in effect, so they are the opt-in set.
    return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
    }
    // The user took control of the source list — nothing is gated; a value the
    // schema would refuse degrades to the default too (same as `loadConfig`).
    if ((parsed as Record<string, unknown>).skillsRepos !== undefined) return none;
    return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
  } catch {
    // Malformed JSON degrades to the default (which loadConfig also does).
    return new Set(DEFAULT_SKILLS_REPOS.map((r) => r.repo));
  }
}

/**
 * Effective worktree retention for a repo (#483 + spec
 * 2026-07-20-multi-project-workspace). Precedence, exactly what Settings →
 * Worktrees promises: the repo's own `worktreeRetention` wins whenever it sets
 * one; otherwise the workspace's `resources.worktreeRetentionDefault` seeds it;
 * an absent/unreadable workspace config keeps the historical 10. Every
 * enforcement site (boot sweeps, terminal transitions, the reclaim route) must
 * go through here so the setting can never be a lie.
 */
export async function resolveWorktreeRetention(repoRoot: string): Promise<number> {
  const own = await ownWorktreeRetention(repoRoot);
  if (own !== undefined) return own;
  const workspace = await loadWorkspaceConfig().catch(() => null);
  return workspace?.resources.worktreeRetentionDefault ?? DEFAULT_WORKTREE_RETENTION;
}
