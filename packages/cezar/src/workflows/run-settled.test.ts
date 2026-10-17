import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { WorkflowDef } from './types.ts';

/** A worktree creation each test releases by hand: the window a cancel leaves open. */
const gate = vi.hoisted(() => ({ started: false, release: (): void => undefined }));

vi.mock('../git-worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-worktree.ts')>();
  return {
    ...actual,
    createWorktree: vi.fn(async (repoRoot: string, runId: string, base: string) => {
      gate.started = true;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      const path = join(repoRoot, '.ai/cezar/worktrees', runId);
      mkdirSync(path, { recursive: true });
      return { path, branch: `cez/${runId.slice(0, 8)}`, baseBranch: base };
    }),
  };
});

import { RunManager } from './run.ts';

const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const workflow: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
};

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('RunManager.settled', () => {
  let root: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    gate.release();
    rmSync(root, { recursive: true, force: true });
  });

  it('waits for an execution a cancel already freed, so a teardown never races its worktree', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-settled-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', [...GIT_ID, 'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: root });
    const store = RunStore.open(join(root, '.ai/cezar'));
    const manager = new RunManager(store, root);
    try {
      const record = manager.startRun(workflow, { task: 'cancelled while its worktree is created' });
      await waitFor(() => gate.started, 'worktree creation to start');

      manager.cancel(record.id);
      // The slot is free at once - that is what `isActive`-based drains relied on...
      expect(manager.isActive(record.id)).toBe(false);
      let done = false;
      const waiting = manager.settled().then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // ...while `execute` is still about to write the worktree into the project directory.
      expect(done).toBe(false);

      gate.release();
      await waiting;
      expect(store.getRun(record.id)?.status).toBe('cancelled');
    } finally {
      manager.dispose();
      store.flush();
    }
  });
});
