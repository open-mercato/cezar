import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, ms = 10_000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

/** #2467: cancelling a check step must take its descendants, not just the wrapper shell. */
describe.runIf(process.platform !== 'win32')('check step cancel kills the whole process tree', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let pids: number[] = [];
  const savedDry = process.env.CEZ_DRY_RUN;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-check-cancel-'));
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    manager.dispose();
    if (savedDry === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDry;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('SIGTERMs the group: a backgrounded descendant that outlives bash is gone after cancel', async () => {
    const pidFile = join(repoRoot, 'pids.txt');
    const wf: WorkflowDef = {
      name: 'check-only',
      source: 'file',
      steps: [{ id: 'verify', name: 'Verify', command: `sleep 300 & echo $! > ${pidFile}; wait` }],
    };
    const record = manager.startRun(wf, { task: 'x', worktree: false });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    pids.push(child);
    expect(alive(child)).toBe(true);

    await manager.cancelAndWait(record.id);
    expect(await waitFor(() => !alive(child))).toBe(true);
  }, 30_000);

  it('dispose() kills an active check\'s descendant', async () => {
    const pidFile = join(repoRoot, 'pids2.txt');
    const wf: WorkflowDef = {
      name: 'check-only',
      source: 'file',
      steps: [{ id: 'verify', name: 'Verify', command: `sleep 301 & echo $! > ${pidFile}; wait` }],
    };
    manager.startRun(wf, { task: 'x', worktree: false });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const child = Number(readFileSync(pidFile, 'utf8').trim());
    pids.push(child);
    expect(alive(child)).toBe(true);

    manager.dispose();
    expect(await waitFor(() => !alive(child))).toBe(true);
  }, 30_000);
});
