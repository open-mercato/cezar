import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree } from '../git-worktree.ts';
import { cezarHomeDir } from '../paths.ts';
import { instancesDir, resetWorktreeHoldersMemo, worktreeInUse } from '../worktree-in-use.ts';
import { reclaimWorktrees, type RetentionStore } from './retention.ts';
import type { RunRecord } from './store.ts';

// Retention must never delete the worktree a running cezar uses: the desktop app can run cezar
// from a task worktree (`cezar link`), and reclaiming it deleted the running build under itself.

const git = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];
const children: ChildProcess[] = [];
const startCwd = process.cwd();
const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const C = 'cccccccc-3333-4333-8333-cccccccccccc';

beforeEach(() => resetWorktreeHoldersMemo());
afterEach(async () => {
  process.chdir(startCwd);
  for (const child of children.splice(0)) await stop(child);
  rmSync(join(cezarHomeDir(), 'versions'), { recursive: true, force: true });
  rmSync(instancesDir(), { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetWorktreeHoldersMemo();
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGKILL');
  await exited;
}

/** Three finished tasks with real worktrees, oldest (A) first. */
async function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cez-in-use-')));
  roots.push(repo);
  await git('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  await git('git', ['add', '-A'], { cwd: repo });
  await git('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repo });
  const runs: RunRecord[] = [];
  for (const [id, day] of [[A, '01'], [B, '02'], [C, '03']] as const) {
    const wt = await createWorktree(repo, id, 'main');
    const at = `2026-07-${day}T00:00:00.000Z`;
    runs.push({ id, status: 'done', createdAt: at, finishedAt: at, worktreePath: wt.path, steps: [] } as unknown as RunRecord);
  }
  const store: RetentionStore = {
    listRuns: () => runs,
    updateRun: (id, patch) => Object.assign(runs.find((r) => r.id === id)!, patch),
  };
  const path = (id: string) => runs.find((r) => r.id === id)!.worktreePath!;
  return { repo, store, path };
}

/** A process standing in for a second cezar: `node` idling with `cwd` inside the worktree. */
async function idleNode(cwd: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' });
  children.push(child);
  await new Promise((done) => child.once('spawn', done));
  return child;
}

describe('retention skips a worktree a running cezar uses', () => {
  it('this process runs from a task worktree: kept, not counted toward keep, eligible again once it leaves', async () => {
    const { repo, store, path } = await fixture();
    process.chdir(path(A));

    expect(await reclaimWorktrees(repo, store, 1)).toEqual([B]);
    expect(existsSync(path(A))).toBe(true);
    expect(existsSync(path(C))).toBe(true); // the protected one did not use up the keep slot

    process.chdir(startCwd);
    resetWorktreeHoldersMemo();
    expect(await reclaimWorktrees(repo, store, 1)).toEqual([A]);
    expect(existsSync(path(A))).toBe(false);
  });

  it('a second instance (another node process) running from the worktree protects it until it exits', async () => {
    const { repo, store, path } = await fixture();
    const child = await idleNode(path(A));

    expect(await worktreeInUse(path(A))).toBe(`a node process (pid ${child.pid}) runs from it`);
    expect(await reclaimWorktrees(repo, store, 1)).toEqual([B]);
    expect(existsSync(path(A))).toBe(true);

    await stop(child);
    resetWorktreeHoldersMemo();
    expect(await reclaimWorktrees(repo, store, 1)).toEqual([A]);
  });

  it('a registered cezar instance whose code lives in the worktree protects it; a dead one does not', async () => {
    const { repo, store, path } = await fixture();
    const child = await idleNode(tmpdir());
    mkdirSync(instancesDir(), { recursive: true });
    const entry = join(instancesDir(), `${child.pid}.json`);
    writeFileSync(entry, JSON.stringify({ pid: child.pid, paths: [path(A)] }));

    expect(await worktreeInUse(path(A))).toBe(`another cezar (pid ${child.pid}) runs from it`);
    expect(await reclaimWorktrees(repo, store, 1)).toEqual([B]);

    await stop(child);
    resetWorktreeHoldersMemo();
    expect(await reclaimWorktrees(repo, store, 1)).toEqual([A]);
    expect(existsSync(entry)).toBe(false); // the stale entry is swept
  });

  it("the desktop app's selected version (a `cezar link` of the worktree) protects it until the switch away", async () => {
    const { repo, store, path } = await fixture();
    const checkout = join(path(A), 'packages', 'cezar');
    mkdirSync(checkout, { recursive: true });
    const versions = join(cezarHomeDir(), 'versions');
    const id = '0.19.0+cez-aaaaaaaa';
    mkdirSync(join(versions, id, 'node_modules', '@open-mercato'), { recursive: true });
    symlinkSync(checkout, join(versions, id, 'node_modules', '@open-mercato', 'cezar'), 'dir');
    writeFileSync(join(versions, id, '.cezar-install.json'), JSON.stringify({ version: '0.19.0', source: 'link', installedAt: '2026-07-01T00:00:00Z', checkout, branch: 'cez/aaaaaaaa' }));
    symlinkSync(id, join(versions, 'current'), 'dir');

    expect(await worktreeInUse(path(A))).toBe('selected as the active cezar version (desktop app / cezar link)');
    expect(await reclaimWorktrees(repo, store, 1)).toEqual([B]);

    rmSync(join(versions, 'current'));
    symlinkSync('0.19.0', join(versions, 'current'), 'dir'); // switched back to a registry release
    resetWorktreeHoldersMemo();
    expect(await reclaimWorktrees(repo, store, 1)).toEqual([A]);
  });

  it('removeWorktree leaves a worktree this process runs from on disk', async () => {
    const { repo, path } = await fixture();
    process.chdir(path(A));
    await removeWorktree(repo, path(A), 'cez/aaaaaaaa');
    expect(existsSync(path(A))).toBe(true);
  });
});
