import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const FIXTURE = fileURLToPath(new URL('../core/__fixtures__/opencode/mock-opencode-serve.mjs', import.meta.url));
const TASK = 'Cannot complete until permission is handled #permission /not-task/required-file';

/** #2102: a turn that ended on a runner-refused permission is not a finished intermediate step. */
describe('denied autonomous intermediate turn (#2102)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let currentId: string | undefined;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-denied-'));
    for (const k of ['CEZ_DRY_RUN', 'CEZ_OPENCODE_BIN']) saved[k] = process.env[k];
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_OPENCODE_BIN = FIXTURE;
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    currentId = undefined;
  });

  afterEach(() => {
    if (currentId) manager.cancel(currentId);
    manager.dispose();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const events = (id: string): Array<{ type: string; message?: string }> => {
    const path = join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`);
    return existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };
  const nudges = (id: string) => events(id).filter((e) => e.type === 'note' && String(e.message).includes('autonomous — continuing'));
  const waitFor = async (pred: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('condition not met in time');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const TWO_STEP: WorkflowDef = {
    name: 'fix-verify',
    source: 'built-in',
    steps: [
      { id: 'fix', name: 'Fix', prompt: '{{task}}' },
      { id: 'verify', name: 'Verify', command: 'true' },
    ],
  };

  it('nudges an autonomous intermediate agent instead of marking it done', async () => {
    const record = manager.startRun(TWO_STEP, { task: TASK, worktree: false, autonomous: true, runner: 'opencode' });
    currentId = record.id;
    await waitFor(() => nudges(record.id).length > 0);
    const steps = store.getRun(record.id)?.steps ?? [];
    expect(steps.find((s) => s.id === 'fix')?.status).not.toBe('done');
    expect(steps.find((s) => s.id === 'verify')?.status).not.toBe('done');
  });

  it('keeps a NON-autonomous intermediate step one-shot', async () => {
    const record = manager.startRun(TWO_STEP, { task: TASK, worktree: false, runner: 'opencode' });
    currentId = record.id;
    await waitFor(() => store.getRun(record.id)?.status === 'done');
    expect(nudges(record.id)).toHaveLength(0);
    expect((store.getRun(record.id) as RunRecord).steps.find((s) => s.id === 'fix')?.status).toBe('done');
  });
});
