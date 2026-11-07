/**
 * Bookkeeping for the `opencode serve` processes cezar starts (#1498).
 *
 * `opencode` is often a launcher that spawns the real server as ITS child, so signalling
 * the launcher's pid alone can leave the server running; and cezar exiting (Ctrl-C, SIGTERM)
 * used to leave every live server behind. Three guarantees live here:
 *  - a server is signalled as a PROCESS GROUP (it is spawned detached) when we can prove the pid
 *    is the real process we started, else just the child;
 *  - every live server is killed synchronously when cezar itself exits;
 *  - a record per server lets the next boot reap one whose owning cezar is gone (a SIGKILLed
 *    cezar runs no exit hook) — and ONLY one it can prove is that same process (see sweep).
 */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cezarHomeDir } from '../paths.ts';

interface ServerRecord {
  pid: number;
  /** /proc starttime of the server: pid reuse cannot make a stranger match. */
  start: string;
  ownerPid: number;
  ownerStart: string;
  port: number;
}

const live = new Map<ChildProcess, { pid: number; proven: boolean }>();
let hookInstalled = false;

function registryDir(): string {
  return join(cezarHomeDir(), 'opencode-servers');
}

function isRecord(v: unknown): v is ServerRecord {
  const r = v as Partial<ServerRecord> | null;
  return (
    typeof r === 'object' && r !== null &&
    Number.isInteger(r.pid) && (r.pid as number) > 1 &&
    Number.isInteger(r.ownerPid) && (r.ownerPid as number) > 0 &&
    Number.isInteger(r.port) &&
    typeof r.start === 'string' && r.start !== '' && typeof r.ownerStart === 'string'
  );
}

/** Field 22 of /proc/<pid>/stat; undefined off Linux or when the process is gone. */
export function procStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch {
    return undefined;
  }
}

function procCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal the server's whole group when the pid is proven ours, else only the child. */
export function signalServer(child: ChildProcess, signal: NodeJS.Signals): void {
  const entry = live.get(child);
  if (entry?.proven) {
    try {
      process.kill(-entry.pid, signal);
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  child.kill(signal);
}

/** Track a freshly spawned (detached) server until it exits. */
export function trackServer(child: ChildProcess, port: number): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const start = procStart(pid);
  live.set(child, { pid, proven: start !== undefined });
  if (!hookInstalled) {
    hookInstalled = true;
    process.on('exit', () => killAllServers());
  }
  const file = join(registryDir(), `${pid}.json`);
  if (start !== undefined) {
    try {
      mkdirSync(registryDir(), { recursive: true });
      const record: ServerRecord = { pid, start, ownerPid: process.pid, ownerStart: procStart(process.pid) ?? '', port };
      writeFileSync(file, JSON.stringify(record));
    } catch {
      // read-only home: the exit hook still covers a clean exit
    }
  }
  child.once('exit', () => {
    live.delete(child);
    // The launcher may exit on its own and leave the server in its group (the pid stays reserved
    // while any member lives, so this can only hit our group); a normal session end removes it too.
    if (start !== undefined) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // group already empty
      }
    }
    try {
      rmSync(file, { force: true });
    } catch {
      // best effort
    }
  });
}

/** Synchronous, for the process `exit` event: no grace window is possible there. */
export function killAllServers(): void {
  for (const child of [...live.keys()]) {
    try {
      signalServer(child, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Boot sweep: kill a recorded server only when (1) the cezar that started it is provably dead —
 * its pid is gone or no longer has the recorded start time — (2) the pid still has the recorded
 * start time and (3) its command line is `serve … --port <recorded>`. A server cezar never
 * recorded (the user's own `opencode serve`) or one whose owner lives (another cezar) is never
 * touched. Needs /proc, so it is a no-op elsewhere. Returns the pids it killed.
 */
export function sweepOrphanedServers(): number[] {
  const killed: number[] = [];
  let files: string[];
  try {
    files = readdirSync(registryDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return killed;
  }
  for (const name of files) {
    const file = join(registryDir(), name);
    try {
      const rec: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!isRecord(rec)) {
        rmSync(file, { force: true });
        continue;
      }
      const ownerGone = !alive(rec.ownerPid) || procStart(rec.ownerPid) !== rec.ownerStart;
      if (!ownerGone || rec.ownerPid === process.pid) continue;
      const cmd = procCmdline(rec.pid);
      if (procStart(rec.pid) === rec.start && /\bserve\b/.test(cmd) && cmd.includes(`--port ${rec.port}`)) {
        try {
          process.kill(-rec.pid, 'SIGKILL');
        } catch {
          process.kill(rec.pid, 'SIGKILL');
        }
        killed.push(rec.pid);
      }
      rmSync(file, { force: true });
    } catch {
      // corrupt JSON is dropped (it can never name a server); a kill that raced stays for next boot
      try {
        JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        rmSync(file, { force: true });
      }
    }
  }
  return killed;
}
