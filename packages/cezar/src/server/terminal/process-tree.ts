import { execFileSync } from 'node:child_process';

/**
 * The process groups under a shell (spec `.ai/specs/2026-10-07-task-workspace.md` §6: "stops its
 * process tree"). An interactive shell runs with job control and gives every job its OWN group,
 * so a signal to the shell's group reaches the shell and nothing it started.
 */

export interface TreeRow {
  pid: number;
  ppid: number;
  pgid: number;
}

/** Parse `ps -axo pid=,ppid=,pgid=`. Malformed rows are skipped — `ps` races process exits. */
export function parseTreeRows(text: string): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return rows;
}

/**
 * Every distinct process group in the tree rooted at `rootPid`, the root's own included — or
 * `null` when the table cannot vouch for that pid.
 *
 * "Vouch" is the guard that makes a group signal safe: the root must be a live DIRECT CHILD of
 * this process. A pid whose shell already exited may have been recycled by an unrelated process,
 * and walking that would signal a stranger's tree. cezar's own group and init's are never
 * returned, whatever the table says.
 */
export function descendantGroups(rows: readonly TreeRow[], rootPid: number, self = process.pid): number[] | null {
  const root = rows.find((row) => row.pid === rootPid);
  if (!root || root.ppid !== self) return null;
  const byParent = new Map<number, TreeRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else byParent.set(row.ppid, [row]);
  }
  const own = rows.find((row) => row.pid === self)?.pgid;
  const groups = new Set<number>();
  const seen = new Set<number>();
  const queue = [root];
  for (let row = queue.shift(); row; row = queue.shift()) {
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    if (row.pgid > 1 && row.pgid !== own && row.pgid !== self) groups.add(row.pgid);
    queue.push(...(byParent.get(row.pid) ?? []));
  }
  return [...groups];
}

/**
 * One SYNCHRONOUS process-table read, or `null` when this host cannot give one (no `ps`, a
 * hidden table, a `ps` that hangs). Synchronous because its caller is a shutdown handler: the
 * tree has to be read before the process exits, and before the shell dies and its children are
 * reparented out of reach. Bounded for the same reason — a stuck `ps` must not hold the exit.
 */
export function readProcessTreeSync(): TreeRow[] | null {
  if (process.platform === 'win32') return null;
  try {
    const text = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], {
      encoding: 'utf8',
      timeout: 1_500,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseTreeRows(text);
  } catch {
    return null;
  }
}
