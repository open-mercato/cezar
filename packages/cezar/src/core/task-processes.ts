/**
 * Processes a task leaves running after it settles (#1411). Every agent is spawned with
 * `CEZ_TASK_ID` in its environment and every descendant inherits it — re-parented, `setsid`ed and
 * double-forked ones included — so the marker finds what a process-tree walk misses, and never a
 * user's own shell in the worktree. It also finds orphans of cezar versions that predate this.
 *
 * Linux reads `/proc/<pid>/environ`; macOS parses `ps -E`; anything else finds nothing. Every
 * failure degrades to "found nothing" — this must never affect a run.
 */

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const MARKER = 'CEZ_TASK_ID';
const SCAN_BATCH = 64;

export interface TaskProcess {
  pid: number;
  /** The `CEZ_TASK_ID` the process was started with. */
  taskId: string;
  /** argv joined with spaces, capped — for the run's lifecycle note only. */
  command: string;
}

/** Off only for the exact value `0`, like every other `CEZ_*` kill switch. */
export function taskProcessReapEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CEZ_TASK_PROCESS_REAP !== '0';
}

/** The `CEZ_TASK_ID` value in a NUL-separated `/proc/<pid>/environ` blob. */
export function taskIdFromEnviron(environ: string): string | undefined {
  for (const entry of environ.split('\0')) {
    if (entry.startsWith(`${MARKER}=`)) return entry.slice(MARKER.length + 1) || undefined;
  }
  return undefined;
}

/** The ppid field of `/proc/<pid>/stat`; the comm field may hold spaces and parens, so read after the LAST `)`. */
export function ppidFromStat(stat: string): number | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Parse `ps -axwwE -o pid=,ppid=,command=` (macOS appends the environment to the command). */
export function parsePsEnvOutput(text: string): { procs: TaskProcess[]; parents: Map<number, number> } {
  const procs: TaskProcess[] = [];
  const parents = new Map<number, number>();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    parents.set(pid, Number(match[2]));
    const rest = match[3] ?? '';
    const marker = new RegExp(`(?:^|\\s)${MARKER}=(\\S+)`).exec(rest);
    if (!marker?.[1]) continue;
    procs.push({ pid, taskId: marker[1], command: capCommand(rest.slice(0, marker.index)) });
  }
  return { procs, parents };
}

function capCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

/** cezar itself and every ancestor — never signalled, whatever they inherited (a nested cezar). */
function excludedPids(parents: (pid: number) => number | undefined): Set<number> {
  const out = new Set<number>();
  let pid: number | undefined = process.pid;
  while (pid !== undefined && pid > 1 && !out.has(pid)) {
    out.add(pid);
    pid = parents(pid);
  }
  return out;
}

async function listLinux(): Promise<TaskProcess[]> {
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return [];
  }
  const found: TaskProcess[] = [];
  const pids = entries.filter((name) => /^\d+$/.test(name));
  // Batched: one open per process at once could hit EMFILE on a busy host and miss processes.
  for (let i = 0; i < pids.length; i += SCAN_BATCH) {
    await Promise.all(
      pids.slice(i, i + SCAN_BATCH).map(async (name) => {
        try {
          // Another user's environ is unreadable (EACCES) — exactly the processes that are not ours.
          const taskId = taskIdFromEnviron(await readFile(`/proc/${name}/environ`, 'utf8'));
          if (!taskId) return;
          const cmdline = await readFile(`/proc/${name}/cmdline`, 'utf8').catch(() => '');
          found.push({ pid: Number(name), taskId, command: capCommand(cmdline.split('\0').join(' ')) });
        } catch {
          // exited mid-scan, or not ours
        }
      }),
    );
  }
  const parents = new Map<number, number | undefined>();
  let pid: number | undefined = process.pid;
  while (pid !== undefined && pid > 1 && !parents.has(pid)) {
    const stat: string = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    const ppid: number | undefined = stat ? ppidFromStat(stat) : undefined;
    parents.set(pid, ppid);
    pid = ppid;
  }
  const excluded = excludedPids((p) => parents.get(p));
  return found.filter((p) => !excluded.has(p.pid));
}

function listDarwin(): Promise<TaskProcess[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-axwwE', '-o', 'pid=,ppid=,command='], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      const { procs, parents } = parsePsEnvOutput(stdout);
      const excluded = excludedPids((p) => parents.get(p));
      resolve(procs.filter((p) => !excluded.has(p.pid)));
    });
  });
}

/** Every live process carrying a `CEZ_TASK_ID`, cezar's own ancestry excluded. Never throws. */
export async function listTaskProcesses(): Promise<TaskProcess[]> {
  try {
    if (process.platform === 'linux') return await listLinux();
    if (process.platform === 'darwin') return await listDarwin();
  } catch {
    // degrade to nothing
  }
  return [];
}

export interface ReapOptions {
  /** Which task ids to reap. */
  match: (taskId: string) => boolean;
  /** Re-asked before each signal; false aborts (the task became live again). */
  stillSettled?: (taskId: string) => boolean;
  /** SIGTERM → SIGKILL grace. */
  killGraceMs?: number;
  /** Injection seams for tests. */
  list?: () => Promise<TaskProcess[]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * SIGTERM every matching process, wait, then SIGKILL whatever is left. Re-lists before each pass so a
 * reused pid is never signalled. Returns the processes that were signalled. Never throws.
 */
export async function reapTaskProcesses(opts: ReapOptions): Promise<TaskProcess[]> {
  const list = opts.list ?? listTaskProcesses;
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const settled = opts.stillSettled ?? (() => true);
  const pick = async (): Promise<TaskProcess[]> =>
    (await list().catch(() => [] as TaskProcess[])).filter((p) => opts.match(p.taskId) && settled(p.taskId));
  const signal = (procs: TaskProcess[], sig: NodeJS.Signals): TaskProcess[] =>
    procs.filter((p) => {
      try {
        kill(p.pid, sig);
        return true;
      } catch {
        return false; // already gone, or not ours to signal
      }
    });

  const terminated = signal(await pick(), 'SIGTERM');
  if (terminated.length === 0) return [];
  await sleep(opts.killGraceMs ?? 3_000);
  const termed = new Set(terminated.map((p) => `${p.pid}:${p.taskId}`));
  signal((await pick()).filter((p) => termed.has(`${p.pid}:${p.taskId}`)), 'SIGKILL');
  return terminated;
}

/** "2 processes: program (pid 41), sleep 100000 (pid 42)" — the run's lifecycle note. */
export function describeReaped(procs: TaskProcess[]): string {
  const shown = procs.slice(0, 5).map((p) => `${p.command || '?'} (pid ${p.pid})`);
  const more = procs.length > shown.length ? `, +${procs.length - shown.length} more` : '';
  return `${procs.length} process${procs.length === 1 ? '' : 'es'}: ${shown.join(', ')}${more}`;
}
