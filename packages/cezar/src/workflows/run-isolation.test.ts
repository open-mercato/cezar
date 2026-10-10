import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';

vi.mock('../git-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-worktree.ts')>();
  return {
    ...actual,
    createWorktree: vi.fn().mockRejectedValue(new Error('simulated worktree failure')),
  };
});

import { RunManager } from './run.ts';
import '../test-fixtures/no-real-namer.testkit.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-root-isolation-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

// 20 s, not 5: see the note on the describe below — these waits must not undercut its timeout.
async function waitForRuns(store: RunStore, ids: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (ids.every((id) => ['done', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? ''))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('runs did not finish');
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

afterEach(async () => {
  await removeTempDir(...roots.splice(0));
});

// Each case drives two or three check steps, and a check step is a `bash -lc` child that starts
// `node`: 2.5–3.3 s per case on Windows with nothing else running, so a loaded full-suite run
// loses the race with the default 5 s — the budget run-lease.test.ts already gives its own
// (#797) for the same reason.
describe('RunManager repository-root isolation', { timeout: 30_000 }, () => {
  it('runs the first task in place with the root lease before a repository has a commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-unborn-isolation-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const record = manager.startRun({
        name: 'first-task', source: 'built-in',
        steps: [{ id: 'check', command: 'node -e "process.exit(0)"' }],
      }, { task: 'first task' });
      await waitForRuns(store, [record.id]);
      expect(store.getRun(record.id)?.status).toBe('done');
      expect(store.getRun(record.id)?.worktreePath).toBeUndefined();
      const notes = store.readEvents(record.id).filter((event) => event.type === 'note');
      expect(notes.some((event) => String(event.message).includes('exclusive access'))).toBe(true);
    } finally {
      manager.dispose();
      store.flush();
    }
  });

  it('fails closed without executing a workflow step when worktree creation fails', async () => {
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    const workflow: WorkflowDef = {
      name: 'must-not-run-in-root',
      source: 'built-in',
      steps: [{ id: 'check', command: 'node -e "require(\'node:fs\').writeFileSync(\'root-was-touched\',\'yes\')"' }],
    };

    const record = manager.startRun(workflow, { task: 'isolated task' });
    await waitForRuns(store, [record.id]);

    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.error).toContain('worktree creation failed');
    expect(existsSync(join(root, 'root-was-touched'))).toBe(false);
    const notes = store.readEvents(record.id).filter((event) => event.type === 'note');
    expect(notes.some((event) => String(event.message).includes('worktree on'))).toBe(true);
    expect(notes.some((event) => String(event.message).includes('(default)'))).toBe(true);
    expect(notes.some((event) => String(event.message).includes('stopped before workflow execution'))).toBe(true);
    expect(notes.some((event) => String(event.message).includes('exclusive access'))).toBe(false);
  });

  it('serializes parallel runs that explicitly opt out of worktrees', async () => {
    const root = fixtureRepo();
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    const workflow: WorkflowDef = {
      name: 'root-lock-check',
      source: 'built-in',
      steps: [
        {
          id: 'check',
          command:
            'node -e "const fs=require(\'node:fs\'); const p=\'root-run.lock\'; if(fs.existsSync(p)) process.exit(42); fs.writeFileSync(p,\'locked\'); setTimeout(()=>fs.rmSync(p),100)"',
        },
      ],
    };

    const first = manager.startRun(workflow, { task: 'first', worktree: false });
    const second = manager.startRun(workflow, { task: 'second', worktree: false });
    await waitForRuns(store, [first.id, second.id]);

    expect(store.getRun(first.id)?.status).toBe('done');
    expect(store.getRun(second.id)?.status).toBe('done');
    for (const id of [first.id, second.id]) {
      const notes = store.readEvents(id).filter((event) => event.type === 'note');
      expect(notes.some((event) => String(event.message).includes('worktree off'))).toBe(true);
      expect(notes.some((event) => String(event.message).includes('exclusive access'))).toBe(true);
    }
  });

  it('allows explicitly unsafe root runs to overlap when the repository lock is disabled', async () => {
    const previous = process.env.CEZ_DISABLE_REPO_LOCK;
    process.env.CEZ_DISABLE_REPO_LOCK = '1';
    try {
      const root = fixtureRepo();
      const store = RunStore.open(join(root, '.ai/cezar'));
      const manager = new RunManager(store, root);
      const workflow: WorkflowDef = {
        name: 'root-lock-bypass-check',
        source: 'built-in',
        steps: [{ id: 'hold', command: 'node -e "setTimeout(()=>{},1500)"' }],
      };

      const first = manager.startRun(workflow, { task: 'first', worktree: false });
      const second = manager.startRun(workflow, { task: 'second', worktree: false });

      await waitFor(
        () =>
          [first.id, second.id].every((id) =>
            store.readEvents(id).some((event) => event.type === 'step-start'),
          ),
        'both unsafe root runs to start their workflow step',
      );
      expect(store.getRun(first.id)?.status).toBe('running');
      expect(store.getRun(second.id)?.status).toBe('running');

      await waitForRuns(store, [first.id, second.id]);

      expect(store.getRun(first.id)?.status).toBe('done');
      expect(store.getRun(second.id)?.status).toBe('done');
      for (const id of [first.id, second.id]) {
        const notes = store.readEvents(id).filter((event) => event.type === 'note');
        expect(notes.some((event) => String(event.message).includes('repository-root lock disabled'))).toBe(true);
        expect(notes.some((event) => String(event.message).includes('exclusive access'))).toBe(false);
      }
    } finally {
      if (previous === undefined) delete process.env.CEZ_DISABLE_REPO_LOCK;
      else process.env.CEZ_DISABLE_REPO_LOCK = previous;
    }
  });
});
