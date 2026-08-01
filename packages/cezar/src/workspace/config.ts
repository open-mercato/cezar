import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { PROVIDER_IDS, type ProviderId } from '../core/provider-auth.ts';
import { assertCezarHomeWriteIsSandboxed, workspaceConfigPath } from '../paths.ts';

/**
 * `~/.cezar/config.json` — the per-user workspace config + project registry
 * (spec 2026-07-20-multi-project-workspace). House rules from the spec's Data
 * Model, applied verbatim:
 *
 * - every field optional/defaulted with `.catch`, so a bad value degrades
 *   per-key instead of discarding the file;
 * - `.passthrough()` at every object level, so keys a *newer* cezar wrote
 *   survive a round-trip through an older one;
 * - `.max()` bounds on strings (this file is parsed on every boot);
 * - atomic tmp+rename writes with mode `0600` (dir `0700`);
 * - a corrupt file degrades to in-memory defaults plus ONE warning line — the
 *   registry rebuilds as projects are opened, so losing it is an
 *   inconvenience, not data loss. The corrupt file is left in place until the
 *   next successful merge-write replaces it.
 */

/** `id` slug rule — mirrors the spec: `^[a-z0-9][a-z0-9-]{0,63}$`. */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * One registry entry. `id` + `root` are load-bearing (an entry without them is
 * useless and gets dropped by the per-entry salvage below); the display fields
 * degrade per-key so one bad value never evicts the project.
 */
const workspaceProjectSchema = z
  .object({
    /** Unique slug — URL segment, sidebar key, worktree namespace. */
    id: z.string().regex(PROJECT_ID_RE),
    /** Absolute, realpath-normalized repo root (normalization is the writer's
     *  job — `registerProject` in step 1.3; the schema only demands absolute). */
    root: z.string().min(1).max(4096).refine((p) => p.startsWith('/'), 'root must be absolute'),
    /** Display name (basename by default). `''` = caller derives a fallback. */
    name: z.string().max(200).catch(''),
    addedAt: z.string().max(64).catch(''),
    lastOpenedAt: z.string().max(64).catch(''),
    source: z.enum(['local', 'checkout']).catch('local'),
    /** Per-project cap on concurrently running tasks. Absent = inherit the
     *  workspace `resources.maxParallel`. Bounded like the workspace cap; a bad
     *  value degrades to "inherit" (`.catch(undefined)`) rather than a hard
     *  default, and `.passthrough()` preserves the key across cezar round-trips. */
    maxParallel: z.number().int().min(1).max(16).optional().catch(undefined),
  })
  .passthrough();

export type WorkspaceProject = z.infer<typeof workspaceProjectSchema>;

const resourcesSchema = z
  .object({
    /** Workspace-wide parallel-task cap (moved from per-repo config.json). */
    maxParallel: z.number().int().min(1).max(16).default(2).catch(2),
    /** Extra durable `CEZ:MONITORING` sessions exempt from the active-task cap. */
    maxMonitoringSessions: z.number().int().min(0).max(16).default(2).catch(2),
    /** Optional cadence for re-checking monitored work; null parks at zero model cost. */
    monitoringWakeIntervalMinutes: z.number().int().min(1).max(60).nullable().default(null).catch(null),
    /** Per-task memory ceiling in MiB; null = no limit (matches the file's
     *  literal `"memoryLimitMb": null` in the spec's Data Model). */
    memoryLimitMb: z.number().int().min(0).max(1_048_576).nullable().default(null).catch(null),
    /** Default worktree retention for projects that don't override it. */
    worktreeRetentionDefault: z.number().int().min(0).max(1000).default(10).catch(10),
  })
  .passthrough();

const composerDefaultsSchema = z
  .object({
    autonomous: z.boolean().optional().catch(undefined),
    worktree: z.boolean().optional().catch(undefined),
  })
  .passthrough();

/**
 * What a repo that has said nothing runs (spec 2026-07-29-agent-profiles).
 *
 * The point is not to configure every checkout: a repo's own `.ai/cezar/config.json` still wins
 * key by key, and this is only consulted where that file is SILENT. Which is why every key here is
 * optional with no default — an absent `runner` has to stay distinguishable from one someone chose,
 * or "fall back to the machine default" collapses into "always claude".
 *
 * Personal and per-machine, like everything else in this file. The repo config is the team's; this
 * is yours.
 */
const agentDefaultsSchema = z
  .object({
    runner: z.enum(PROVIDER_IDS).optional().catch(undefined),
    models: z
      .object({
        claude: z.string().trim().min(1).max(200).optional().catch(undefined),
        codex: z.string().trim().min(1).max(200).optional().catch(undefined),
        opencode: z.string().trim().min(1).max(200).optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

const workspacePathSchema = (envName: 'CEZ_BROWSE_ROOT' | 'CEZ_PROJECTS_DIR', fallback: string) => {
  const defaultValue = () => process.env[envName]?.trim() || fallback;
  return z.string().min(1).max(4096).default(defaultValue).catch(defaultValue);
};

const providerIdSet = new Set<string>(PROVIDER_IDS);

const disabledProvidersSchema = z
  .array(z.unknown())
  .default(() => [])
  .catch(() => [])
  .transform((values): ProviderId[] => {
    const seen = new Set<ProviderId>();
    for (const value of values) {
      if (typeof value !== 'string' || !providerIdSet.has(value)) continue;
      seen.add(value as ProviderId);
    }
    return PROVIDER_IDS.filter((provider) => seen.has(provider));
  });

const workspaceConfigSchema = z
  .object({
    /** Migration cursor (src/workspace/migrations.ts). Absent/bad → 0, which
     *  means "run every migration" — each one is idempotent, so that is safe. */
    schemaVersion: z.number().int().min(0).default(0).catch(0),
    /** Root exposed by the Add project folder browser. Environment supplies
     *  the zero-config default; an explicit workspace value wins thereafter. */
    browseRoot: workspacePathSchema('CEZ_BROWSE_ROOT', '~/'),
    /** Checkout root for GUI-cloned projects. Stored as written (a literal
     *  `~` is expanded by the checkout flow, not here); validated writable
     *  when *changed*, never at load. */
    projectsDir: workspacePathSchema('CEZ_PROJECTS_DIR', '~/cezar/projects'),
    /** Optional auto-update override. Absence inherits the environment/default
     *  and must stay absent on unrelated merge-writes. */
    skillsAutoUpdate: z.boolean().optional().catch(undefined),
    /** Global opt-in model policy. The native coding-agent model becomes
     * authoritative while runner choice remains available. */
    modelsLocked: z.boolean().optional().catch(undefined),
    // Function-form default/catch: mutators (step 1.3's registerProject) edit
    // these objects in place, so parses must never share one reference.
    resources: resourcesSchema.prefault(() => ({})).catch(() => resourcesSchema.parse({})),
    /** Optional New Task policy. Missing keys inherit exact 0/1 environment seeds. */
    composerDefaults: composerDefaultsSchema.default(() => ({})).catch(() => ({})),
    /** Host-wide provider preferences; absent means every provider is enabled. */
    disabledProviders: disabledProvidersSchema,
    /** Machine-wide agent/model defaults for repos that set none of their own. */
    agentDefaults: agentDefaultsSchema.default(() => ({})).catch(() => ({})),
    /** Per-entry salvage: a corrupt entry is dropped, the rest of the registry
     *  survives (a whole-array `.catch([])` would evict every project over one
     *  bad row). */
    projects: z
      .array(z.unknown())
      .default(() => [])
      .catch(() => [])
      .transform((entries) =>
        entries.flatMap((entry) => {
          const parsed = workspaceProjectSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
  })
  .passthrough();

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

/** Resolve the auto-update preference without mutating or materializing it. */
export function effectiveSkillsAutoUpdate(
  config: Pick<WorkspaceConfig, 'skillsAutoUpdate'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.skillsAutoUpdate !== undefined) return config.skillsAutoUpdate;
  if (env.CEZ_SKILLS_AUTO_UPDATE === '0') return false;
  if (env.CEZ_SKILLS_AUTO_UPDATE === '1') return true;
  return true;
}

export function effectiveComposerDefault(
  stored: boolean | undefined,
  envValue: string | undefined,
  fallback: boolean,
): boolean {
  if (stored !== undefined) return stored;
  if (envValue === '0') return false;
  if (envValue === '1') return true;
  return fallback;
}

/** The in-memory default — what a missing/corrupt file behaves like. */
export function defaultWorkspaceConfig(): WorkspaceConfig {
  return workspaceConfigSchema.parse({});
}

/**
 * The last-known-good copy of a NON-EMPTY registry, written beside the config
 * by every successful merge-write. The registry is cheap to rebuild in theory
 * ("open the project again"), but in practice it is a hand-curated list, and a
 * single bad write — a crash between `writeFileSync` and `rename`, a full
 * disk, a stray process — costs the user every entry. One extra file, no
 * configuration, and `loadWorkspaceConfig` falls back to it.
 *
 * Removing `~/.cezar` still resets cezar completely; removing only
 * `config.json` no longer does, because this snapshot restores it.
 *
 * A cezar older than this change does not refresh the snapshot, so on a machine
 * that alternates between versions it can lag behind the registry — which only
 * shows if the config file is also lost, and the worst case is a project the
 * user unregistered reappearing. Cheap next to losing the whole list.
 */
export function workspaceConfigBackupPath(path: string = workspaceConfigPath()): string {
  return `${path}.bak`;
}

function parseWorkspaceConfig(raw: string): WorkspaceConfig | null {
  try {
    const parsed = workspaceConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The snapshot is only worth restoring while it still holds projects — an
 *  empty one carries no information the defaults do not already have. */
async function loadWorkspaceConfigBackup(path: string): Promise<WorkspaceConfig | null> {
  let raw: string;
  try {
    raw = await readFile(workspaceConfigBackupPath(path), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseWorkspaceConfig(raw);
  return parsed && parsed.projects.length > 0 ? parsed : null;
}

/**
 * Read `~/.cezar/config.json` on demand — never cached, never throws. A
 * missing file is the zero-config default (silent); an unreadable or
 * malformed one degrades to the same default with a one-line warning and is
 * left on disk untouched (the next successful merge-write replaces it).
 *
 * Before degrading, a missing, empty, or corrupt file is restored from the
 * `config.json.bak` snapshot when that still holds projects. The restore is
 * read-only: the recovered registry is handed back in memory and lands on disk
 * again through the next merge-write, so a read never writes. A file that
 * parses and simply has no projects is NOT restored — that is a user who
 * removed their last project, not a lost registry.
 *
 * `path` defaults to the current `workspaceConfigPath()`, but a caller that
 * will also WRITE passes the path it resolved itself — see
 * `mergeWriteWorkspaceConfig` for why resolving it twice is a data-loss bug.
 */
export async function loadWorkspaceConfig(path: string = workspaceConfigPath()): Promise<WorkspaceConfig> {
  let raw: string | null = null;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // missing/unreadable — the backup below is the next chance
  }
  if (raw !== null && raw.trim() !== '') {
    const parsed = parseWorkspaceConfig(raw);
    if (parsed) return parsed;
  }
  const restored = await loadWorkspaceConfigBackup(path);
  if (restored) {
    const cause = raw === null ? 'is missing' : 'is empty or corrupt';
    console.warn(
      `[cez] workspace config ${path} ${cause} — restored ${restored.projects.length} project(s) from ${workspaceConfigBackupPath(path)}`,
    );
    return restored;
  }
  if (raw === null) return defaultWorkspaceConfig();
  console.warn(`[cez] workspace config ${path} is corrupt — using defaults (registry rebuilds)`);
  return defaultWorkspaceConfig();
}

/**
 * The tmp path an atomic write stages through — UNIQUE PER WRITE, never a
 * fixed `${path}.tmp`. `~/.cezar/` is shared by every cezar process on the
 * machine (a `serve` per repo, `cezar run`s, a settings PUT), and two writers
 * staging through the same tmp name interleave: writer B's `O_TRUNC` open can
 * empty the file between writer A's write and rename, so A renames a
 * truncated/half-written file into place — and B's own rename then throws
 * `ENOENT` on the name A consumed. The pid + random suffix gives every writer
 * its own staging file, so the only cross-process contention left is the
 * rename itself, which is atomic.
 */
export function atomicTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/** Atomic JSON write (`0600`, dir `0700`) via a per-writer tmp + rename —
 *  shared by the workspace config and ui-state writers. Throws on write
 *  failure (e.g. a read-only home) — degrading is the caller's policy. */
export function atomicWriteJsonSync(path: string, value: unknown): void {
  assertCezarHomeWriteIsSandboxed(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = atomicTmpPath(path);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600); // best-effort — ignored on some filesystems
  } catch {
    // non-fatal
  }
}

/**
 * Read-modify-write merge: re-read the file, apply `mutator`, atomic-rename
 * write (`0600`, dir `0700`). Because every writer re-reads immediately before
 * writing, two processes registering different projects converge instead of
 * dropping each other's entries (last-writer-wins only within the tiny
 * read→rename window — acceptable for a registry that self-heals on next
 * boot). The mutator may mutate its argument in place or return a replacement.
 * Returns the config that was written. Throws on write failure (e.g. a
 * read-only home) — degrading is the caller's policy, per house rules.
 *
 * The path is resolved ONCE, before the `await`, and the same value feeds the
 * read and the write. Resolving it twice used to lose the whole registry:
 * `workspaceConfigPath()` re-reads `CEZ_HOME` on every call, so if the variable
 * changed while the read was in flight — a test's `afterEach` dropping its pin
 * after a timeout is the way this happens in practice — the read came from one
 * home and the write landed in another, replacing that file's registry with a
 * config it never held. One resolution keeps a merge-write inside exactly one
 * file, whatever the environment does mid-flight.
 */
export async function mergeWriteWorkspaceConfig(
  mutator: (config: WorkspaceConfig) => WorkspaceConfig | void,
): Promise<WorkspaceConfig> {
  const path = workspaceConfigPath();
  const current = await loadWorkspaceConfig(path);
  const next = mutator(current) ?? current;
  atomicWriteJsonSync(path, next);
  // Refresh the snapshot after EVERY successful write, including an emptied
  // registry (#731). Skipping the empty case left a stale non-empty backup:
  // removing the last project, then losing config.json, resurrected the project
  // the user had deliberately unregistered. An empty snapshot is not restored on
  // load (see loadWorkspaceConfigBackup), so recovery now settles on the empty
  // registry the user intended rather than the old projects.
  try {
    atomicWriteJsonSync(workspaceConfigBackupPath(path), next);
  } catch {
    // Best-effort: the registry itself is already safely on disk, and a
    // failed snapshot must never turn a successful write into an error.
  }
  return next;
}
