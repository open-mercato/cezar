/**
 * Which task worktrees a running cezar (or any node process) is using right now. Retention, the
 * explicit removes and `removeWorktree` itself refuse to delete one: the desktop app can run cezar
 * from a task worktree (`cezar link`), and reclaiming it deleted the running build under itself.
 *
 * Every signal is a resolved real path, never a guess:
 *   - this process: its own module file, `argv[1]` and its working directory;
 *   - the desktop shell's selection: `~/.cezar/versions/current` when it is a `link` install;
 *   - other cezar servers on this machine: `~/.cezar/instances/<pid>.json`, written by `serve`;
 *   - any other node process (an older cezar that never registers, `node …/dist/index.js serve`
 *     started from inside a worktree): its cwd and script path, from `/proc` or `ps` + `lsof`.
 * Nothing is stored about the worktree itself, so it is eligible again once nothing runs from it.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from './paths.ts';
import { processStarts } from './runtime/process-identity.ts';
import { activeId, readManifest, versionDir } from './self-update/layout.ts';

/** A path some process runs from, and the human reason shown in the cockpit and in refusals. */
export interface WorktreeHolder {
  path: string;
  reason: string;
}

const PROBE_TIMEOUT_MS = 5_000;
const MEMO_MS = 2_000;

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The holder whose path lies inside (or is) `worktreePath`, compared by real path. */
export function holderOf(worktreePath: string, holders: readonly WorktreeHolder[]): WorktreeHolder | undefined {
  const root = real(worktreePath) ?? resolve(worktreePath);
  return holders.find((holder) => holder.path === root || holder.path.startsWith(root + sep));
}

function selfHolders(): WorktreeHolder[] {
  const out: WorktreeHolder[] = [];
  const add = (path: string | null, reason: string) => { if (path) out.push({ path, reason }); };
  add(real(fileURLToPath(import.meta.url)), 'this cezar runs its code from it');
  if (process.argv[1]) add(real(process.argv[1]), 'this cezar runs its code from it');
  add(real(process.cwd()), 'this cezar runs from it (working directory)');
  return out;
}

/** The desktop shell runs `versions/current` — a `link` install is a worktree checked out in place. */
function desktopHolders(env: NodeJS.ProcessEnv): WorktreeHolder[] {
  const out: WorktreeHolder[] = [];
  const reason = 'selected as the active cezar version (desktop app / cezar link)';
  const id = activeId(env);
  if (id) {
    const manifest = readManifest(id, env);
    if (manifest?.source === 'link' && manifest.checkout) {
      const checkout = real(manifest.checkout);
      if (checkout) out.push({ path: checkout, reason });
    }
    const pkg = real(join(versionDir(id, env), 'node_modules', '@open-mercato', 'cezar'));
    if (pkg) out.push({ path: pkg, reason });
  }
  const entry = env.CEZ_DESKTOP_ENTRY ? real(env.CEZ_DESKTOP_ENTRY) : null;
  if (entry) out.push({ path: entry, reason: 'the desktop app runs cezar from it (CEZ_DESKTOP_ENTRY)' });
  return out;
}

// ---- the instance registry: `~/.cezar/instances/<pid>.json` (written, never required) ----

const instanceSchema = z.object({
  pid: z.number().int().positive(),
  start: z.string().optional(),
  paths: z.array(z.string()),
  startedAt: z.string().optional(),
}).passthrough();

export function instancesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(cezarHomeDir(env), 'instances');
}

/**
 * Record this server's code and working directory so a second cezar on the machine sees them.
 * Best-effort; returns the cleanup that removes the entry (also run on `exit`).
 */
export async function registerRunningInstance(env: NodeJS.ProcessEnv = process.env): Promise<() => void> {
  const dir = instancesDir(env);
  const file = join(dir, `${process.pid}.json`);
  try {
    assertCezarHomeWriteIsSandboxed(dir, env);
    const start = await processStarts([process.pid]).then((starts) => starts.get(process.pid)).catch(() => undefined);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record = { pid: process.pid, ...(start ? { start } : {}), paths: selfHolders().map((h) => h.path), startedAt: new Date().toISOString() };
    writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    return () => undefined;
  }
  const cleanup = () => { try { rmSync(file, { force: true }); } catch { /* best-effort */ } };
  process.once('exit', cleanup);
  return cleanup;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function instanceHolders(env: NodeJS.ProcessEnv): Promise<WorktreeHolder[]> {
  const dir = instancesDir(env);
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return []; }
  const records: z.infer<typeof instanceSchema>[] = [];
  for (const name of names) {
    try {
      const parsed = instanceSchema.safeParse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
      if (parsed.success && parsed.data.pid !== process.pid) records.push(parsed.data);
    } catch { /* a half-written or foreign file is not an instance */ }
  }
  const starts = await processStarts(records.map((r) => r.pid)).catch(() => null);
  const out: WorktreeHolder[] = [];
  for (const record of records) {
    // Fail closed: when start tokens cannot be read, a pid that exists still counts as alive.
    const alive = starts
      ? starts.has(record.pid) && (!record.start || starts.get(record.pid) === record.start)
      : pidAlive(record.pid);
    if (!alive) {
      try { assertCezarHomeWriteIsSandboxed(dir, env); rmSync(join(dir, `${record.pid}.json`), { force: true }); } catch { /* stale, harmless */ }
      continue;
    }
    for (const path of record.paths) {
      const resolved = real(path);
      if (resolved) out.push({ path: resolved, reason: `another cezar (pid ${record.pid}) runs from it` });
    }
  }
  return out;
}

// ---- the process scan: node processes' cwd and script paths ----

interface NodeProcess { pid: number; cwd?: string; args: string[] }

function run(command: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (_error, stdout) => done(stdout ?? ''));
  });
}

function linuxNodeProcesses(): NodeProcess[] {
  const out: NodeProcess[] = [];
  let entries: string[];
  try { entries = readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return out; }
  for (const name of entries) {
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!isNodeCommand(args[0])) continue;
      out.push({ pid: Number(name), cwd: readlinkSync(`/proc/${name}/cwd`), args: args.slice(1) });
    } catch { /* gone, or another user's process */ }
  }
  return out;
}

async function darwinNodeProcesses(): Promise<NodeProcess[]> {
  const byPid = new Map<number, NodeProcess>();
  for (const line of (await run('ps', ['-axww', '-o', 'pid=,args='])).split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const args = match[2]!.split(/\s+/);
    if (isNodeCommand(args[0])) byPid.set(Number(match[1]), { pid: Number(match[1]), args: args.slice(1) });
  }
  if (byPid.size === 0) return [];
  // One lsof for every candidate's cwd: `p<pid>` then `n<path>` lines.
  let pid = 0;
  for (const line of (await run('lsof', ['-a', '-d', 'cwd', '-p', [...byPid.keys()].join(','), '-Fpn'])).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) { const proc = byPid.get(pid); if (proc) proc.cwd = line.slice(1); }
  }
  return [...byPid.values()];
}

export function isNodeCommand(argv0: string | undefined): boolean {
  if (!argv0) return false;
  const base = argv0.split(/[\\/]/).pop()!.toLowerCase();
  return base === 'node' || base === 'node.exe' || /^node\d+$/.test(base);
}

async function processHolders(): Promise<WorktreeHolder[]> {
  let procs: NodeProcess[];
  if (process.platform === 'linux') procs = linuxNodeProcesses();
  else if (process.platform === 'darwin') procs = await darwinNodeProcesses();
  else return []; // Windows: the instance registry and the desktop pin still apply
  const out: WorktreeHolder[] = [];
  for (const proc of procs) {
    if (proc.pid === process.pid) continue;
    const reason = `a node process (pid ${proc.pid}) runs from it`;
    const cwd = proc.cwd ? real(proc.cwd) : null;
    if (cwd) out.push({ path: cwd, reason });
    for (const arg of proc.args) {
      if (arg.startsWith('-') || !/[\\/]/.test(arg)) continue;
      const path = real(isAbsolute(arg) || !proc.cwd ? arg : join(proc.cwd, arg));
      if (path) out.push({ path, reason });
    }
  }
  return out;
}

// ---- the probe ----

let memo: { at: number; holders: Promise<WorktreeHolder[]> } | undefined;

/** Every path a running process uses, self first so its reason wins. Memoized briefly. */
export function worktreeHolders(env: NodeJS.ProcessEnv = process.env): Promise<WorktreeHolder[]> {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_MS) return memo.holders;
  const holders = (async () => [
    ...selfHolders(),
    ...desktopHolders(env),
    ...await instanceHolders(env).catch(() => []),
    ...await processHolders().catch(() => []),
  ])();
  memo = { at: now, holders };
  return holders;
}

/** Test seam: the next probe re-reads the machine. */
export function resetWorktreeHoldersMemo(): void {
  memo = undefined;
}

/** Why `worktreePath` must not be removed right now, or null when nothing runs from it. */
export async function worktreeInUse(worktreePath: string): Promise<string | null> {
  return holderOf(worktreePath, await worktreeHolders())?.reason ?? null;
}

/** The refusal an explicit remove answers with. */
export function inUseRefusal(reason: string): string {
  return `worktree is in use — ${reason}; stop that process (or switch the desktop app to another version) and retry`;
}
