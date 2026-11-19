// A task's files outside `runs/` die with the task (spec 2026-11-19-worktree-disk-usage):
// `artifacts/<runId>`, its `dispatch/<rootRunId>` tree once no member is left, and the
// attachment-library copies (#929) no remaining task holds. The library is shared and names files
// by the user's filename, so ownership is by CONTENT: a library file is a task's when its bytes
// equal a file in that task's `runs/<id>-images/` folder (the copy is filed from there). Every
// helper is best-effort and never throws.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** A library file filed this recently may still be landing beside its run-folder twin. */
const LIBRARY_GRACE_MS = 60 * 60_000;

/** Same folder as `attachmentLibraryDir` (workflows/run.ts); the store may not import upward. */
export function attachmentLibraryPath(dataDir: string): string {
  return join(dataDir, 'attachments');
}

export function runImagesDir(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', `${runId}-images`);
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function sizeOf(path: string): number | undefined {
  try { return statSync(path).size; } catch { return undefined; }
}

function hashOf(path: string): string | undefined {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return undefined; }
}

/** size → hashes of the files in these run folders; hashing only what a size match asks for. */
class ContentIndex {
  private readonly bySize = new Map<number, string[]>();
  private readonly hashes = new Map<string, string | undefined>();

  constructor(files: readonly string[]) {
    for (const file of files) {
      const size = sizeOf(file);
      if (size === undefined) continue;
      const list = this.bySize.get(size) ?? [];
      list.push(file);
      this.bySize.set(size, list);
    }
  }

  has(size: number, hash: () => string | undefined): boolean {
    const same = this.bySize.get(size);
    if (!same?.length) return false;
    const wanted = hash();
    if (!wanted) return true; // unreadable: assume held, never delete on doubt
    return same.some((file) => {
      if (!this.hashes.has(file)) this.hashes.set(file, hashOf(file));
      return this.hashes.get(file) === wanted;
    });
  }
}

function runFolderFiles(dataDir: string, runIds: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of runIds) out.push(...listFiles(runImagesDir(dataDir, id)));
  return out;
}

/**
 * Delete the library files that only `owners` held: equal in content to a file in an owner's run
 * folder, and to none in a `remaining` run's. Call BEFORE the owners' run folders are removed.
 */
export function deleteLibraryCopies(
  dataDir: string,
  owners: readonly string[],
  remaining: Iterable<string>,
  now = Date.now(),
): string[] {
  const owned = new ContentIndex(runFolderFiles(dataDir, owners));
  return deleteUnheld(attachmentLibraryPath(dataDir), owned, () => new ContentIndex(runFolderFiles(dataDir, remaining)), now);
}

function deleteUnheld(
  libraryDir: string,
  candidates: ContentIndex | null,
  heldBy: () => ContentIndex,
  now: number,
): string[] {
  const deleted: string[] = [];
  let held: ContentIndex | undefined;
  for (const file of listFiles(libraryDir)) {
    try {
      const stat = statSync(file);
      if (now - stat.mtimeMs < LIBRARY_GRACE_MS) continue;
      let hash: string | undefined | null = null;
      const lazyHash = () => (hash === null ? (hash = hashOf(file)) : hash);
      if (candidates && !candidates.has(stat.size, lazyHash)) continue;
      held ??= heldBy();
      if (held.has(stat.size, lazyHash)) continue;
      rmSync(file, { force: true });
      deleted.push(file);
    } catch {
      // best effort
    }
  }
  return deleted;
}

/**
 * Startup sweep for files whose task is gone: `artifacts/<id>` and `dispatch/<root>` no known run
 * claims, and library files no known run's folder holds. `known` is every run id in the index;
 * `treeRoots` every `dispatch.rootRunId` a known run belongs to.
 */
export function sweepOrphanTaskFiles(
  dataDir: string,
  known: ReadonlySet<string>,
  treeRoots: ReadonlySet<string>,
  now = Date.now(),
): { artifacts: string[]; dispatch: string[]; library: string[] } {
  const orphans = (dir: string, keep: (name: string) => boolean): string[] => {
    const removed: string[] = [];
    let names: string[];
    try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return removed; }
    for (const name of names) {
      if (keep(name)) continue;
      try {
        // A directory created moments ago may belong to a run the index has not saved yet.
        if (now - statSync(join(dir, name)).mtimeMs < LIBRARY_GRACE_MS) continue;
        rmSync(join(dir, name), { recursive: true, force: true });
        removed.push(name);
      } catch { /* best effort */ }
    }
    return removed;
  };
  const libraryDir = attachmentLibraryPath(dataDir);
  return {
    artifacts: orphans(join(dataDir, 'artifacts'), (id) => known.has(id)),
    dispatch: orphans(join(dataDir, 'dispatch'), (id) => known.has(id) || treeRoots.has(id)),
    library: deleteUnheld(libraryDir, null, () => new ContentIndex(runFolderFiles(dataDir, known)), now)
      .map((file) => file.slice(libraryDir.length + 1)),
  };
}
