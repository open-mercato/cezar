import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn(), ps: vi.fn(), psSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: io.read, readdirSync: io.list }));
vi.mock('node:fs/promises', () => ({ readFile: io.read, readdir: io.list }));
vi.mock('node:child_process', () => ({ execFile: io.ps, execFileSync: io.psSync }));

import { foregroundCommand, hasForeground, processSnapshot, resetProcessSnapshot } from './foreground.ts';
import { descendantGroups, readProcessTreeSync } from './process-tree.ts';
import { parseProcStat, readLinuxProcesses, readLinuxProcessesSync, readLinuxProcessTreeSync } from './linux-proc.ts';

const root = process.pid;
const shell = root + 10;
const elevated = root + 20;
const job = root + 30;
const unrelated = root + 40;
const stat = (pid: number, ppid: number, pgid: number, name = 'bash') => `${pid} (${name}) S ${ppid} ${pgid} 0 0 0 0`;

/** A root-owned/setuid child bridges to a user-owned grandchild; no UID read is allowed. */
function fixture() {
  const files = new Map<string, string>();
  const dirs = new Map<string, string[]>();
  for (const [pid, ppid, pgid, children] of [
    [root, 1, root, [shell]], [shell, root, shell, [elevated]],
    [elevated, shell, elevated, [job]], [job, elevated, job, []],
  ] as const) {
    files.set(`/proc/${pid}/stat`, stat(pid, ppid, pgid));
    files.set(`/proc/${pid}/cmdline`, pid === elevated ? '/usr/bin/sudo\0build\0' : '/bin/bash\0');
    files.set(`/proc/${pid}/task/${pid}/children`, children.join(' '));
    files.set(`/proc/${pid}/task/${pid}/stat`, stat(pid, ppid, pgid));
    dirs.set(`/proc/${pid}/task`, [String(pid)]);
  }
  io.ps.mockImplementation((_file, _args, _options, callback) => callback(null, `${root} 1 node\n${shell} ${root} bash\n`));
  io.psSync.mockImplementation((file: string) => file === process.execPath
    ? JSON.stringify(readLinuxProcessesSync()) : `${root} 1 ${root}\n${shell} ${root} ${shell}\n`);
  const access: string[] = [];
  const missing = () => Object.assign(new Error('gone'), { code: 'ENOENT' });
  io.read.mockImplementation((path: string) => {
    access.push(path);
    if (!files.has(path)) throw missing();
    return files.get(path);
  });
  io.list.mockImplementation((path: string) => {
    access.push(path);
    if (!dirs.has(path)) throw new Error(`Unscoped directory read: ${path}`);
    return dirs.get(path);
  });
  return { files, dirs, access };
}

const gone = (code = 'ENOENT') => Object.assign(new Error('gone'), { code });

/** Fail `path` with `code` from its `nth` read on (1-based), delegating everything else. */
function failRead(path: string, code: string, nth = 1) {
  const read = io.read.getMockImplementation();
  let count = 0;
  io.read.mockImplementation((p: string) => {
    if (p === path && ++count >= nth) throw gone(code);
    return read?.(p);
  });
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); resetProcessSnapshot(); Object.defineProperty(process, 'platform', platform); });

// Every fs read is mocked, so this runs on every OS; only the dispatchers need to think it is Linux.
describe('Linux terminal proc access (#2349)', () => {
  beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'linux' }); });

  it('retains elevated children and descendant groups without opening unrelated proc files', async () => {
    const { access } = fixture();
    const rows = await readLinuxProcesses();
    expect(rows).not.toBeNull();
    expect(hasForeground(rows ?? [], shell)).toBe(true);
    expect(foregroundCommand(rows ?? [], shell)).toBe('sudo build');
    expect(descendantGroups(rows ?? [], shell, root)).toEqual([shell, elevated, job]);
    const sync = readLinuxProcessesSync();
    expect(descendantGroups(sync ?? [], shell, root)).toEqual([shell, elevated, job]);
    expect(access.every((path) => [root, shell, elevated, job].some((pid) => path.startsWith(`/proc/${pid}/`)))).toBe(true);
    expect(access).not.toContain(`/proc/${unrelated}/stat`);
    expect(access.some((path) => path.endsWith('/status'))).toBe(false);
  });

  it.each(['foreground', 'shutdown'] as const)('routes the %s production reader through scoped proc IO, with no ps fallback', async (reader) => {
    fixture();
    expect(reader === 'foreground' ? await processSnapshot() : readProcessTreeSync()).not.toBeNull();
    expect(io.ps).not.toHaveBeenCalled();
    expect(io.psSync.mock.calls.some(([file]) => file === 'ps')).toBe(false);
  });

  it('bounds shutdown with a killable helper and validates its output', () => {
    fixture();
    expect(readLinuxProcessTreeSync()).not.toBeNull();
    const [file, args, options] = io.psSync.mock.calls[0]!;
    expect(file).toBe(process.execPath);
    // Source runs load THIS package's tsx by absolute URL, from the helper's own directory.
    expect(args[0]).toBe('--import');
    expect(args[1]).toMatch(/^file:\/\/.*\/node_modules\/tsx\//);
    expect(args.slice(2)).toEqual([expect.stringMatching(/linux-proc\.ts$/), '--terminal-proc-tree', String(root)]);
    expect(options).toEqual(expect.objectContaining({ timeout: 5_000, killSignal: 'SIGKILL', cwd: expect.stringMatching(/terminal$/) }));
    io.psSync.mockImplementation(() => { throw new Error('timed out'); });
    expect(readLinuxProcessTreeSync()).toBeNull();
    io.psSync.mockReturnValue('[{"pid":12,"ppid":"wrong","pgid":12}]');
    expect(readLinuxProcessTreeSync()).toBeNull();
  });

  it('reads children forked by a non-leader thread and deduplicates links', () => {
    const { files, dirs } = fixture();
    dirs.set(`/proc/${shell}/task`, [String(shell), String(shell + 1)]);
    files.set(`/proc/${shell}/task/${shell}/children`, '');
    files.set(`/proc/${shell}/task/${shell + 1}/children`, `${elevated} ${elevated}`);
    expect(readLinuxProcessesSync()?.map((row) => row.pid)).toEqual([root, shell, elevated, job]);
  });

  it('keeps a hidden elevated command busy using comm when cmdline is denied', async () => {
    fixture();
    const read = io.read.getMockImplementation();
    io.read.mockImplementation((path: string) => {
      if (path === `/proc/${elevated}/cmdline`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read?.(path);
    });
    const rows = await readLinuxProcesses();
    expect(hasForeground(rows ?? [], shell)).toBe(true);
    expect(foregroundCommand(rows ?? [], shell)).toBe('bash');
    expect(descendantGroups(rows ?? [], shell, root)).toEqual([shell, elevated, job]);
  });

  it('returns unknown on denied relationship reads, never a false idle table or global ps', async () => {
    fixture();
    const read = io.read.getMockImplementation();
    io.read.mockImplementation((path: string) => {
      if (path === `/proc/${shell}/task/${shell}/children`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read?.(path);
    });
    expect(await processSnapshot()).toBeNull();
    expect(readProcessTreeSync()).toBeNull();
    expect(io.ps).not.toHaveBeenCalled();
    expect(io.psSync.mock.calls.some(([file]) => file === 'ps')).toBe(false);
  });

  it('handles exited children but refuses recycled child links before reading their commands or descendants', async () => {
    const { files, access } = fixture();
    files.set(`/proc/${elevated}/stat`, stat(elevated, unrelated, elevated));
    const rows = await readLinuxProcesses();
    expect(rows?.map((row) => row.pid)).toEqual([root, shell]);
    expect(access).not.toContain(`/proc/${elevated}/cmdline`);
    expect(access).not.toContain(`/proc/${elevated}/task`);
    files.delete(`/proc/${elevated}/stat`);
    files.set(`/proc/${shell}/task/${shell}/children`, '');
    expect(readLinuxProcessesSync()?.map((row) => row.pid)).toEqual([root, shell]);
  });

  it('keeps a live hidepid=2 child unknown when its stat looks missing', async () => {
    const { files } = fixture();
    // hidepid=2 reports ENOENT for an elevated child that remains in its
    // visible parent's children list. It has not exited and must not look idle.
    files.delete(`/proc/${elevated}/stat`);
    expect(await processSnapshot()).toBeNull();
    expect(readLinuxProcessesSync()).toBeNull();
    expect(readProcessTreeSync()).toBeNull();
    expect(io.ps).not.toHaveBeenCalled();
    expect(io.psSync.mock.calls.some(([file]) => file === 'ps')).toBe(false);
  });

  it('skips a hidden child whose parent thread exited during the hidepid recheck', async () => {
    const { files } = fixture();
    files.delete(`/proc/${elevated}/stat`);
    failRead(`/proc/${shell}/task/${shell}/children`, 'ENOENT', 2);
    expect(readLinuxProcessesSync()?.map((row) => row.pid)).toEqual([root, shell]);
    fixture().files.delete(`/proc/${elevated}/stat`);
    failRead(`/proc/${shell}/task/${shell}/children`, 'ESRCH', 2);
    expect((await readLinuxProcesses())?.map((row) => row.pid)).toEqual([root, shell]);
  });

  it('keeps a descendant that exited before its threads were listed, without its subtree', async () => {
    fixture();
    const list = io.list.getMockImplementation();
    io.list.mockImplementation((path: string) => {
      if (path === `/proc/${elevated}/task`) throw gone();
      return list?.(path);
    });
    expect(readLinuxProcessesSync()?.map((row) => row.pid)).toEqual([root, shell, elevated]);
    expect((await readLinuxProcesses())?.map((row) => row.pid)).toEqual([root, shell, elevated]);
  });

  it.each(['ENOENT', 'ESRCH'])('skips a thread that exited between listing and reading its children (%s)', async (code) => {
    const { files, dirs } = fixture();
    dirs.set(`/proc/${shell}/task`, [String(shell), String(shell + 1)]);
    files.set(`/proc/${shell}/task/${shell + 1}/children`, '');
    failRead(`/proc/${shell}/task/${shell + 1}/children`, code);
    // Its task stat is gone too, so this is an exit, not a kernel without children files.
    expect(readLinuxProcessesSync()?.map((row) => row.pid)).toEqual([root, shell, elevated, job]);
    expect(descendantGroups((await readLinuxProcesses()) ?? [], shell, root)).toEqual([shell, elevated, job]);
    // The root's own worker threads may exit mid-walk as well.
    dirs.set(`/proc/${root}/task`, [String(root), String(root + 1)]);
    expect(readLinuxProcessesSync()?.map((row) => row.pid)).toEqual([root, shell, elevated, job]);
  });

  it('fails unknown for missing root, missing children support and malformed stats', async () => {
    const { files } = fixture();
    files.delete(`/proc/${root}/stat`);
    expect(readLinuxProcessesSync()).toBeNull();
    fixture().files.delete(`/proc/${root}/task/${root}/children`);
    expect(await readLinuxProcesses()).toBeNull();
    fixture().files.set(`/proc/${shell}/stat`, 'invalid');
    expect(readLinuxProcessesSync()).toBeNull();
  });

  it('bounds both traversals and never returns a partial successful table', async () => {
    fixture();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 500);
    expect(readLinuxProcessesSync()).toBeNull();
    expect(await readLinuxProcesses()).toBeNull();
  });

  it('shares foreground snapshots and avoids cmdline reads during shutdown', async () => {
    const { access } = fixture();
    await Promise.all([processSnapshot(), processSnapshot()]);
    expect(access.filter((path) => path === `/proc/${root}/stat`)).toHaveLength(1);
    access.length = 0;
    readProcessTreeSync();
    expect(access.some((path) => path.endsWith('/cmdline'))).toBe(false);
  });
});

it('parses stat comm with whitespace and parentheses, rejecting malformed identities', () => {
  expect(parseProcStat('42 (a ) name\n(x)) S 11 22 33')).toEqual({ pid: 42, ppid: 11, pgid: 22, command: 'a ) name\n(x)' });
  expect(parseProcStat('42 (x) S nope 22')).toBeNull();
  expect(parseProcStat('0 (x) S 1 2')).toBeNull();
  expect(parseProcStat('not stat')).toBeNull();
});
