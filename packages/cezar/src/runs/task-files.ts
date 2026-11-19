// A task's files outside `runs/` die with the task (spec 2026-11-19-worktree-disk-usage):
// `artifacts/<runId>`, and its `dispatch/<rootRunId>` tree once no member is left. The task's own
// attachments live in `runs/<id>-images` and go with the record. The attachment library (#929) is
// deliberately NOT touched: it is built to outlive tasks, and agents and users write to it.
// Every helper is best-effort and never throws.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A directory created this recently may belong to a run the index has not saved yet. */
const ORPHAN_GRACE_MS = 60 * 60_000;

/**
 * Startup sweep for files whose task is gone: `artifacts/<id>` and `dispatch/<root>` no known run
 * claims. `known` is every run id in the index; `treeRoots` every `dispatch.rootRunId` a known run
 * belongs to. The caller must only pass a COMPLETE index — an unread record looks like a gone task.
 */
export function sweepOrphanTaskFiles(
  dataDir: string,
  known: ReadonlySet<string>,
  treeRoots: ReadonlySet<string>,
  now = Date.now(),
): { artifacts: string[]; dispatch: string[] } {
  const orphans = (dir: string, keep: (name: string) => boolean): string[] => {
    const removed: string[] = [];
    let names: string[];
    try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return removed; }
    for (const name of names) {
      if (keep(name)) continue;
      try {
        if (now - statSync(join(dir, name)).mtimeMs < ORPHAN_GRACE_MS) continue;
        rmSync(join(dir, name), { recursive: true, force: true });
        removed.push(name);
      } catch { /* best effort */ }
    }
    return removed;
  };
  return {
    artifacts: orphans(join(dataDir, 'artifacts'), (id) => known.has(id)),
    dispatch: orphans(join(dataDir, 'dispatch'), (id) => known.has(id) || treeRoots.has(id)),
  };
}
