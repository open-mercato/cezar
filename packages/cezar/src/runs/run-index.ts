import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { reconcileLoadedRun, runRecordSchema, type RunRecord } from './store.ts';

/**
 * The READ-ONLY half of `runs.json`, for the workspace-level run index (`GET
 * /workspace/runs-index`) — the one place that must read a project's runs WITHOUT owning it.
 *
 * `RunStore.open` cannot be used here and the reason is the whole point of this module. Opening a
 * store `mkdir`s `<dataDir>/runs/`, and the caller that opens one goes on to build a
 * `ProjectContext` — which prunes orphan worktrees and calls `manager.recover()`, resuming
 * interrupted runs. Building the workspace index must never do any of that: answering "which
 * tasks exist" would restart agents across every registered project, and typing into a search box
 * would spend tokens. Cold projects are precisely the ones the index exists to reach, so
 * `contexts.peek()` (which returns nothing for them) is not an answer either.
 *
 * What this does share with the store is the schema and `reconcileLoadedRun`, so a `running` row
 * left behind by a crashed process reads as interrupted here exactly as it would once the project
 * were opened for real. A second, subtly different parse of that field would show a task as
 * running in the palette and failed the moment you clicked it.
 */
export function readRunIndexFromDisk(dataDir: string): RunRecord[] {
  const indexPath = join(dataDir, 'runs.json');
  if (!existsSync(indexPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
    const parsed = z.array(runRecordSchema).safeParse(raw);
    if (!parsed.success) return [];
    // `reconcileLoadedRun` mutates, which is safe here in a way it is not in the store: these
    // records were just parsed into fresh objects that nothing else holds a reference to.
    // Never `keepLive` — this reader has no RunManager, so there is nothing to recover into.
    return parsed.data.map((run) => reconcileLoadedRun(run));
  } catch {
    // Corrupt or unreadable index. A project that cannot be read contributes nothing to the
    // index rather than failing the whole workspace's search — the same degrade-quietly rule
    // the rest of the registry follows.
    return [];
  }
}
