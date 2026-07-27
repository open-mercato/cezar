import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cezarHomeDir, workspaceConfigPath } from '../paths.js';
import { readUiState } from '../ui-state.js';
import { loadWorkspaceConfig, mergeWriteWorkspaceConfig } from './config.js';
import { mergeWriteWorkspaceUiState } from './ui-state.js';

// Step 1.4 exported the global ui-state merge-write from here; step 2.7 moved
// it to its cleaner home (src/workspace/ui-state.ts, next to the read path the
// workspace routes share). Re-exported so existing importers keep working.
export { mergeWriteWorkspaceUiState } from './ui-state.js';

/**
 * Workspace config migrations (spec 2026-07-20-multi-project-workspace,
 * "Migrations"). Deliberately tiny and **config-files-only** — run state
 * (`runs.json`, NDJSON) keeps the existing additive-zod convention and never
 * migrates. Rules, verbatim from the spec:
 *
 * - **idempotent** — every migration is safe to re-run after a crash mid-way;
 * - **additive** — never deletes or rewrites the user's per-repo files;
 * - **non-blocking** — a failing migration logs ONE warning and boot proceeds
 *   degraded with in-memory defaults; it is never a boot failure (the
 *   zero-config law "a read-only home degrades to a smaller cockpit" holds);
 * - **concurrency-safe** — every write takes the same read-modify-write +
 *   atomic-rename path as all workspace writes (`mergeWriteWorkspaceConfig`),
 *   and two processes racing the same idempotent step converge.
 */

export interface WorkspaceMigration {
  /** `schemaVersion` this migration produces. */
  to: number;
  /** Stable id for the warning line, e.g. `'001-workspace-config'`. */
  id: string;
  /** The migration body — MUST be idempotent (see module docs). */
  run(ctx: { home: string; bootRepoRoot: string | null }): Promise<void>;
}

/** Tolerant raw-JSON read: missing/unreadable/malformed/non-object → null. */
async function readRawObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    return asObject(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The boot repo's `.ai/cezar/config.json` resource keys, read RAW (not through
 * `loadConfig`) so only values the user explicitly set are imported — a
 * defaulted value must not masquerade as a preference. Bounds mirror the
 * workspace `resources` schema; out-of-range values are simply not imported.
 */
async function readRepoResourceKeys(
  repoRoot: string,
): Promise<{ maxParallel?: number; memoryLimitMb?: number }> {
  const raw = await readRawObject(join(repoRoot, '.ai/cezar', 'config.json'));
  const out: { maxParallel?: number; memoryLimitMb?: number } = {};
  const maxParallel = raw?.maxParallel;
  if (typeof maxParallel === 'number' && Number.isInteger(maxParallel) && maxParallel >= 1 && maxParallel <= 16) {
    out.maxParallel = maxParallel;
  }
  const memoryLimitMb = raw?.memoryLimitMb;
  if (
    typeof memoryLimitMb === 'number' &&
    Number.isInteger(memoryLimitMb) &&
    memoryLimitMb >= 0 &&
    memoryLimitMb <= 1_048_576
  ) {
    out.memoryLimitMb = memoryLimitMb;
  }
  return out;
}

/**
 * Migration 001 — `schemaVersion 0 → 1`, the "current version up" migration:
 *
 * 1. Create `~/.cezar/config.json` with defaults if absent (the merge-write
 *    does this even when there is nothing to import).
 * 2. Booting inside a repo: import its `maxParallel`/`memoryLimitMb` into
 *    workspace `resources`, and its `appearance`/`notifications` ui-state
 *    keys into `~/.cezar/ui-state.json`. Keys already set globally are NEVER
 *    overwritten — presence is checked against the RAW global file (before
 *    defaults are applied), which is exactly what makes a crash-interrupted
 *    re-run safe: the first pass writes the keys, the re-run sees them set.
 * 3. Every per-repo file is left untouched in place, so an older cezar run in
 *    the same repo keeps working off its local copies.
 *
 * Registering the boot repo is NOT part of the migration — the normal boot
 * flow owns registration (single owner, no divergent `addedAt`/`source`).
 */
const migration001: WorkspaceMigration = {
  to: 1,
  id: '001-workspace-config',
  async run({ bootRepoRoot }) {
    // Raw presence check BEFORE the first write: after any merge-write the
    // global file contains every defaulted key, so "already set globally"
    // must be decided against what the user's file held coming in.
    const rawGlobal = await readRawObject(workspaceConfigPath());
    const rawResources = asObject(rawGlobal?.resources);
    const imported = bootRepoRoot ? await readRepoResourceKeys(bootRepoRoot) : {};
    await mergeWriteWorkspaceConfig((config) => {
      if (imported.maxParallel !== undefined && rawResources?.maxParallel === undefined) {
        config.resources.maxParallel = imported.maxParallel;
      }
      if (imported.memoryLimitMb !== undefined && rawResources?.memoryLimitMb === undefined) {
        config.resources.memoryLimitMb = imported.memoryLimitMb;
      }
    });
    if (!bootRepoRoot) return;
    const repoUiState = await readUiState(bootRepoRoot);
    const uiKeys = (['appearance', 'notifications'] as const).filter(
      (key) => repoUiState[key] !== undefined,
    );
    if (uiKeys.length === 0) return; // nothing to import — don't create the file
    await mergeWriteWorkspaceUiState((state) => {
      for (const key of uiKeys) {
        if (state[key] === undefined) state[key] = repoUiState[key];
      }
    });
  },
};

/** All known migrations. Kept in ascending `to` order; `runMigrations` sorts
 *  defensively anyway. */
export const WORKSPACE_MIGRATIONS: readonly WorkspaceMigration[] = [migration001];

/**
 * Run every pending workspace migration — called at boot before anything else
 * touches `~/.cezar`. Reads `schemaVersion` (absent file or key → 0, which
 * means "run everything" — safe because every migration is idempotent), runs
 * each migration with `to > current` in ascending order, and persists the new
 * `schemaVersion` after EACH one, so a crash resumes exactly where it left
 * off. A failing migration logs ONE warning and stops the chain (later
 * migrations may depend on earlier ones); boot proceeds degraded on in-memory
 * defaults. Never throws.
 *
 * `migrations` is injectable for tests only; production callers pass nothing.
 */
export async function runMigrations(
  opts: { bootRepoRoot: string | null },
  migrations: readonly WorkspaceMigration[] = WORKSPACE_MIGRATIONS,
): Promise<void> {
  const home = cezarHomeDir();
  const ordered = [...migrations].sort((a, b) => a.to - b.to);
  let current = (await loadWorkspaceConfig()).schemaVersion;
  for (const migration of ordered) {
    if (migration.to <= current) continue;
    try {
      await migration.run({ home, bootRepoRoot: opts.bootRepoRoot });
      const written = await mergeWriteWorkspaceConfig((config) => {
        config.schemaVersion = Math.max(config.schemaVersion, migration.to);
      });
      current = written.schemaVersion;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[cez] workspace migration ${migration.id} failed (${message}) — booting with in-memory defaults`,
      );
      return;
    }
  }
}
