import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

type Request = { kind: 'read' | 'list'; path: string };
const BUDGET_MS = 1_500;
const MAX_READS = 100_000;

/** comm may contain spaces, newlines and closing parentheses (#2349). */
export function parseProcStat(text: string): ProcRow | null {
  const start = /^(\d+) \(/.exec(text);
  const end = text.lastIndexOf(')');
  if (!start || end < start[0].length) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const ppid = fields[1];
  const pgid = fields[2];
  if (!ppid || !pgid || !/^\d+$/.test(ppid) || !/^\d+$/.test(pgid)) return null;
  const pid = Number(start[1]);
  if (![pid, Number(ppid), Number(pgid)].every(Number.isSafeInteger) || pid < 1) return null;
  return { pid, ppid: Number(ppid), pgid: Number(pgid), command: text.slice(start[0].length, end) };
}

function ids(text: string): number[] {
  if (!text.trim()) return [];
  return text.trim().split(/\s+/).map((id) => {
    const value = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(value)) throw new Error('Invalid proc id');
    return value;
  });
}

function vanished(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ESRCH');
}

/** A children list, or null when its task exited between listing and reading (#2349). */
function* readChildren(path: string): Generator<Request, number[] | null, string> {
  try {
    return ids(yield { kind: 'read', path });
  } catch (error) {
    if (vanished(error)) return null;
    throw error;
  }
}

/** One traversal for both drivers; no /proc enumeration or UID filter (#2349). */
function* traverse(commands: boolean, root: number): Generator<Request, ProcRow[] | null, string> {
  const rows: ProcRow[] = [];
  const queue = [{ pid: root, parent: undefined as number | undefined, childrenPath: undefined as string | undefined }];
  const seen = new Set<number>();
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    if (!entry || seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    let row: ProcRow | null;
    try {
      row = parseProcStat(yield { kind: 'read', path: `/proc/${entry.pid}/stat` });
    } catch (error) {
      if (entry.childrenPath && vanished(error)) {
        // hidepid=2 also reports ENOENT for live elevated descendants. Only discard a
        // missing child once its visible parent's link is gone — or the parent's own
        // children file is gone too, because that thread exited (#2349).
        const siblings = yield* readChildren(entry.childrenPath);
        if (siblings?.includes(entry.pid)) return null;
        continue;
      }
      throw error;
    }
    if (!row || row.pid !== entry.pid) return null;
    // A stale children entry must not make us walk a recycled, unrelated PID.
    if (entry.parent !== undefined && row.ppid !== entry.parent) continue;
    if (commands) {
      try {
        const cmdline = yield { kind: 'read', path: `/proc/${row.pid}/cmdline` };
        row.command = cmdline.split('\0').filter(Boolean).join(' ') || row.command;
      } catch {
        // A setuid child may hide its arguments; comm still names the live command.
      }
    }
    rows.push(row);
    let threads: number[];
    try {
      threads = ids(yield { kind: 'list', path: `/proc/${row.pid}/task` });
    } catch (error) {
      if (entry.parent !== undefined && vanished(error)) continue;
      throw error;
    }
    if (threads.length === 0) return null;
    for (const tid of threads) {
      const childrenPath = `/proc/${row.pid}/task/${tid}/children`;
      const children = yield* readChildren(childrenPath);
      if (children === null) {
        // ENOENT is also a kernel without CONFIG_PROC_CHILDREN: only a thread whose own stat
        // is gone too has exited. Its children were reparented; skip the branch.
        try {
          yield { kind: 'read', path: `/proc/${row.pid}/task/${tid}/stat` };
        } catch (error) {
          if (vanished(error)) continue;
          throw error;
        }
        return null;
      }
      for (const pid of children) queue.push({ pid, parent: row.pid, childrenPath });
    }
  }
  return rows;
}

/** Async polling and sync shutdown have the same scope, parsing and failure rules. */
export async function readLinuxProcesses(commands = true): Promise<ProcRow[] | null> {
  const deadline = performance.now() + BUDGET_MS;
  const walk = traverse(commands, process.pid);
  try {
    let step = walk.next();
    for (let reads = 0; !step.done; reads++) {
      if (reads >= MAX_READS || performance.now() >= deadline) return null;
      const request = step.value;
      try {
        const value = request.kind === 'list'
          ? (await readdir(request.path)).join(' ')
          : await readFile(request.path, { encoding: 'utf8', signal: AbortSignal.timeout(BUDGET_MS) });
        step = walk.next(value);
      } catch (error) {
        step = walk.throw(error);
      }
    }
    return performance.now() < deadline ? step.value : null;
  } catch {
    return null;
  } finally {
    walk.return(null);
  }
}

/** Budget checked between local proc syscalls; never starts a subprocess on Linux. */
export function readLinuxProcessesSync(root = process.pid): ProcRow[] | null {
  const deadline = performance.now() + BUDGET_MS;
  const walk = traverse(false, root);
  try {
    let step = walk.next();
    for (let reads = 0; !step.done; reads++) {
      if (reads >= MAX_READS || performance.now() >= deadline) return null;
      const request = step.value;
      try {
        const value = request.kind === 'list'
          ? readdirSync(request.path).join(' ')
          : readFileSync(request.path, 'utf8');
        step = walk.next(value);
      } catch (error) {
        step = walk.throw(error);
      }
    }
    return performance.now() < deadline ? step.value : null;
  } catch {
    return null;
  } finally {
    walk.return(null);
  }
}

const treeSchema = z.array(z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative(),
  pgid: z.number().int().nonnegative(),
})).nullable();

/** Source (dev/test) runs pay a cold tsx start before the walk's own budget begins. */
const SOURCE_HELPER_TIMEOUT_MS = 5_000;

/**
 * Keep shutdown's hard ps timeout even if a proc syscall stalls (#2349). Synchronous, so it
 * blocks the event loop for one node start plus the walk — the same trade the old `ps` made.
 */
export function readLinuxProcessTreeSync(): z.infer<typeof treeSchema> {
  try {
    const entry = fileURLToPath(import.meta.url);
    // Source runs resolve tsx from THIS package, never from the server's cwd; the
    // published .js helper needs only Node.
    const source = entry.endsWith('.ts');
    const loader = source ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [];
    const output = execFileSync(process.execPath, [...loader, entry, '--terminal-proc-tree', String(process.pid)], {
      encoding: 'utf8', timeout: source ? SOURCE_HELPER_TIMEOUT_MS : BUDGET_MS, killSignal: 'SIGKILL',
      cwd: dirname(entry), maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return treeSchema.parse(JSON.parse(output));
  } catch {
    return null;
  }
}

// Only direct helper execution writes stdout; importing the module has no side effects.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--terminal-proc-tree') {
  const root = process.argv[3];
  const pid = Number(root);
  const rows = root && /^[1-9]\d*$/.test(root) && Number.isSafeInteger(pid)
    ? readLinuxProcessesSync(pid) : null;
  process.stdout.write(JSON.stringify(rows));
}
