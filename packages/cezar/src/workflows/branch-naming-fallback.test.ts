import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';

/**
 * The fallbacks of the branch-name wait (spec 2026-10-11-branch-naming-instructions): a namer
 * slower than the budget, a namer that answers without a branch, a generated name git refuses at
 * fork time, and a Cancel during the wait. The namer is mocked because the dry-run mock always
 * answers instantly and always with a branch.
 */

let namerBehaviour: 'stall' | 'no-branch' | 'branch' = 'stall';
/** Makes `createWorktree` refuse any explicit branch, as a ref race or lock failure would. */
let refuseNamedBranch = false;

vi.mock('../runs/auto-name.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runs/auto-name.ts')>();
  return {
    ...actual,
    generateRunName: vi.fn(async () => {
      if (namerBehaviour === 'stall') return new Promise<never>(() => {});
      if (namerBehaviour === 'branch') return { titleSummary: 'implementing cr fixes', branch: 'feature/raced' };
      return { titleSummary: 'implementing cr fixes' };
    }),
  };
});

vi.mock('../git-worktree.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-worktree.ts')>();
  return {
    ...actual,
    createWorktree: vi.fn(async (...args: Parameters<typeof actual.createWorktree>) => {
      if (refuseNamedBranch && args[3]?.branch) {
        throw new Error(`git worktree add failed: cannot lock ref 'refs/heads/${args[3].branch}'`);
      }
      return actual.createWorktree(...args);
    }),
  };
});

import { RunManager } from './run.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const CHECK_ONLY: WorkflowDef = {
  name: 'check-only',
  source: 'built-in',
  steps: [{ id: 'check', command: 'node -e "process.exit(0)"' }],
};

const roots: string[] = [];
const savedAutoname = process.env.CEZ_AUTONAME;

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-branch-fallback-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ branchNaming: 'start with feature/' }));
  return root;
}

async function waitForDone(store: RunStore, id: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (['done', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '')) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${id} did not finish: ${store.getRun(id)?.status}`);
}

beforeEach(() => {
  process.env.CEZ_AUTONAME = '1';
});

afterEach(() => {
  refuseNamedBranch = false;
  if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
  else process.env.CEZ_AUTONAME = savedAutoname;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function runOnce(): Promise<{ branch: string | undefined; notes: string[]; id: string }> {
  const root = fixtureRepo();
  const store = RunStore.open(join(root, '.ai/cezar'));
  const manager = new RunManager(store, root, { branchNameWaitMs: 50 });
  try {
    const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
    await waitForDone(store, record.id);
    const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String(e.message));
    return { branch: store.getRun(record.id)?.branch, notes, id: record.id };
  } finally {
    manager.dispose();
    store.flush();
  }
}

describe('branch naming fallbacks', () => {
  it('a namer slower than the wait budget forks on cez/<id8> and says so', async () => {
    namerBehaviour = 'stall';
    const { branch, notes, id } = await runOnce();
    expect(branch).toBe(`cez/${id.slice(0, 8)}`);
    expect(notes.some((n) => n.includes('not ready in time'))).toBe(true);
  }, 30_000);

  it('a namer that answers without a branch forks on cez/<id8> with the other note', async () => {
    namerBehaviour = 'no-branch';
    const { branch, notes, id } = await runOnce();
    expect(branch).toBe(`cez/${id.slice(0, 8)}`);
    expect(notes.some((n) => n.includes('answered no branch name'))).toBe(true);
    expect(notes.some((n) => n.includes('not ready in time'))).toBe(false);
  }, 30_000);

  it('a generated name git refuses at fork time degrades to cez/<id8> instead of failing the task', async () => {
    namerBehaviour = 'branch';
    refuseNamedBranch = true;
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, { branchNameWaitMs: 2_000 });
    try {
      const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
      await waitForDone(store, record.id);
      const run = store.getRun(record.id);
      const notes = store.readEvents(record.id).filter((e) => e.type === 'note').map((e) => String(e.message));
      expect(run?.status).toBe('done');
      expect(run?.branch).toBe(`cez/${record.id.slice(0, 8)}`);
      expect(notes.some((n) => n.includes('generated branch "feature/raced" could not be created'))).toBe(true);
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);

  it('a Cancel during the branch wait never forks the cancelled run', async () => {
    namerBehaviour = 'stall';
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root, { branchNameWaitMs: 400 });
    try {
      const record = manager.startRun(CHECK_ONLY, { task: 'implement the cr fixes' });
      const deadline = Date.now() + 10_000;
      while (!store.readEvents(record.id).some((e) => e.type === 'note' && String(e.message).startsWith('worktree on'))) {
        if (Date.now() > deadline) throw new Error('the run never reached the fork');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(manager.cancel(record.id)).toBe(true);
      await waitForDone(store, record.id);
      // Outlive the wait budget: the resumed fork is what must not happen.
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(store.getRun(record.id)?.status).toBe('cancelled');
      expect(store.getRun(record.id)?.worktreePath).toBeUndefined();
      expect(store.getRun(record.id)?.branch).toBeUndefined();
    } finally {
      manager.dispose();
      store.flush();
    }
  }, 30_000);
});
