import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_WORKSPACE_LAYOUTS,
  workspaceLayoutsSchema,
  type WorkspaceLayouts,
} from '@open-mercato/cezar-contract';
import { atomicWriteJsonSync } from '../workspace/config.ts';

/**
 * The per-run workspace layout store (spec `.ai/specs/2026-10-07-task-workspace.md` §5.3:
 * "Persist named layouts per task **on the Cezar host that owns the task**").
 *
 * ```
 * .ai/cezar/layouts/<runId>.json    { layouts: [{ name, columns: [...] }], active }
 * ```
 *
 * On the HOST, not in the browser, and that is the requirement rather than an implementation
 * taste: §5.3 also says "Local Cezar and a VPS each keep their own layouts" — which a file beside
 * the run satisfies exactly, since the file lives with the cezar that owns the worktree — and
 * "Layouts are removed only when the task itself is permanently deleted", which browser storage
 * cannot promise at all (clearing site data, a second browser, another machine). The same task
 * opened from a different browser against the same cezar is the same task, and now shows the same
 * layouts.
 *
 * House style, inherited from `runs/drafts.ts` and `workspace/ui-state.ts`: reads NEVER throw —
 * missing, unreadable, malformed and corrupt all degrade to "no saved layouts", which the cockpit
 * turns into the default `Czat` card (§5.3's recovery rule); writes are atomic (tmp + rename,
 * `0600`) so a crash mid-write cannot leave a truncated file; and every axis is bounded.
 *
 * One file per run, so removing a task's layouts is one `rm` with no shared index to rewrite.
 *
 * Knows nothing about HTTP. The routes in `server/server.ts` own status codes; this owns the files.
 */

/** Everything the store keeps for one project lives here. */
export function layoutsRoot(dataDir: string): string {
  return join(dataDir, 'layouts');
}

/** A run id is a store-minted uuid, never user input — but this is the last line before the
 *  filesystem, so it is checked here rather than trusted from the caller. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function layoutsPath(dataDir: string, runId: string): string | null {
  if (!RUN_ID_RE.test(runId)) return null;
  return join(layoutsRoot(dataDir), `${runId}.json`);
}

/**
 * The layouts saved for this run, or `null` when it has none.
 *
 * `null` and "an empty list" are different facts and are kept apart here: no file at all means
 * the task has never been opened, while `layouts: []` means every card was closed. The COCKPIT
 * opens a fresh `Czat` for both — §5.3: "reopening that task creates a fresh default `Czat`
 * layout" — so the distinction is the store's honesty about what it holds, not a behaviour the
 * user sees. What stays empty across a reload is a CARD with no columns (§10), which is a
 * layout and round-trips as one.
 */
export function readRunLayouts(dataDir: string, runId: string): WorkspaceLayouts | null {
  const path = layoutsPath(dataDir, runId);
  if (path === null) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const result = workspaceLayoutsSchema.safeParse(parsed);
    // A malformed file is "no saved layouts", never a throw and never a 500: §5.3 asks that
    // unreadable state recover to the default without an error.
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Replace this run's layouts. The value is re-validated here, not merely at the route, because
 *  this is what actually reaches the disk. */
export function writeRunLayouts(dataDir: string, runId: string, value: WorkspaceLayouts): boolean {
  const path = layoutsPath(dataDir, runId);
  if (path === null) return false;
  const result = workspaceLayoutsSchema.safeParse(value);
  if (!result.success) return false;
  try {
    atomicWriteJsonSync(path, result.data);
    return true;
  } catch {
    return false;
  }
}

/** Forget this run's layouts — permanent task deletion, and nothing else (§5.3: archiving keeps
 *  them for the unarchive). */
export function deleteRunLayouts(dataDir: string, runId: string): void {
  const path = layoutsPath(dataDir, runId);
  if (path === null) return;
  try {
    rmSync(path, { force: true });
  } catch {
    /* already gone, or a read-only home — either way there is nothing to report */
  }
}

/**
 * Drop layout files for runs the store no longer has.
 *
 * A backstop, not the delete path: `deleteRunLayouts` runs when a task is deleted through the
 * cockpit, and this catches the files left by a run record removed some other way (a hand-edited
 * `runs.json`, a restored backup). Bounded by `MAX_WORKSPACE_LAYOUTS` per file, so the store
 * cannot grow without one.
 */
export function pruneOrphanLayouts(dataDir: string, knownRunIds: ReadonlySet<string>): number {
  const root = layoutsRoot(dataDir);
  if (!existsSync(root)) return 0;
  let removed = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const runId = entry.name.slice(0, -'.json'.length);
      if (knownRunIds.has(runId)) continue;
      deleteRunLayouts(dataDir, runId);
      removed += 1;
    }
  } catch {
    return removed;
  }
  return removed;
}

export { MAX_WORKSPACE_LAYOUTS };
