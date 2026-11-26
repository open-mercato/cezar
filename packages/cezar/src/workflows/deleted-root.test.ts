import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** A project folder deleted from disk under a waiting task: End session and Cancel used to throw
 *  ENOENT from the history write and 500 forever, leaving the agent alive. */
describe('a waiting task whose project folder was deleted', { timeout: 20_000 }, () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;
  const SINGLE_STEP: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }],
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gone-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.md'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const record of store.listRuns()) {
      try { manager.cancel(record.id); } catch { /* already settled */ }
    }
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    try { store.flush(); } catch { /* folder is gone on purpose */ }
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const waitFor = async (id: string, pred: (r: RunRecord | undefined) => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred(store.getRun(id))) {
      if (Date.now() > deadline) throw new Error(`condition not met in time (status ${store.getRun(id)?.status})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const parkThenDelete = async (): Promise<string> => {
    const record = manager.startRun(SINGLE_STEP, { task: 'hello' });
    await waitFor(record.id, (r) => r?.status === 'waiting');
    rmSync(repoRoot, { recursive: true, force: true });
    return record.id;
  };

  it('End session closes the session instead of throwing', async () => {
    const id = await parkThenDelete();
    expect(manager.finish(id)).toBe(true);
    await waitFor(id, (r) => r?.status !== 'waiting');
    expect(manager.isActive(id)).toBe(false);
  });

  it('Cancel settles the run instead of throwing', async () => {
    const id = await parkThenDelete();
    expect(manager.cancel(id)).toBe(true);
    expect(store.getRun(id)?.status).toBe('cancelled');
  });
});
