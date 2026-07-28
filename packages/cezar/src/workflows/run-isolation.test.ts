import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.js';
import type { WorkflowDef } from './types.js';

vi.mock('../git-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-worktree.js')>();
  return {
    ...actual,
    createWorktree: vi.fn().mockRejectedValue(new Error('simulated worktree failure')),
  };
});

import { RunManager } from './run.js';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const roots: string[] = [];

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-root-isolation-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
  return root;
}

async function waitForRuns(store: RunStore, ids: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (ids.every((id) => ['done', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? ''))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('runs did not finish');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RunManager repository-root isolation', () => {
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
});
