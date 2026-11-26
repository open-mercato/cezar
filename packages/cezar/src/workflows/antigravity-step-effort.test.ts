import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAntigravityEffortCatalog } from '../core/antigravity-effort.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);

/** An antigravity step's effort becomes a model variant at spawn (core/antigravity-effort.ts), through the real engine. */
describe('antigravity workflow step effort', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  const workflow = (step: Partial<WorkflowDef['steps'][number]>): WorkflowDef => ({
    name: 'agy-effort', source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}', runner: 'antigravity', reasoningEffort: 'high', ...step }],
  });
  const settled = (id: string) => ['done', 'review', 'failed', 'cancelled'].includes(store.getRun(id)?.status ?? '');
  const messages = (id: string) => store.readEvents(id).map((event) => String(event.message ?? ''));
  async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-agy-step-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(async () => {
    setAntigravityEffortCatalog(undefined);
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      await until(() => store.listRuns().every(({ id }) => !manager?.isActive(id)), 'runs to stop');
      manager.dispose();
      manager = undefined;
    }
    await store.flush?.();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('headless (no model catalog): fails the step with the reason instead of running without the effort', async () => {
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow({ model: 'gemini-4-neon' }), { task: 'do it', worktree: false });
    await until(() => settled(started.id), 'run to settle');
    const record = store.getRun(started.id);
    expect(record?.status).toBe('failed');
    expect(`${record?.error ?? ''}\n${record?.steps.map((step) => step.error ?? '').join('\n')}\n${messages(started.id).join('\n')}`)
      .toContain('step "work": antigravity model list is unavailable, so --effort high cannot be mapped to a variant of \'gemini-4-neon\'');
  }, 40_000);

  it('with the discovered list: spawns the variant and notes the mapping', async () => {
    setAntigravityEffortCatalog({ get: async () => ({ runner: 'antigravity', source: 'live', stale: false, models: ['gemini-4-neon-low', 'gemini-4-neon-high'].map((id) => ({ id, label: id, description: '' })) }) });
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow({ model: 'gemini-4-neon' }), { task: 'do it', worktree: false });
    await until(() => messages(started.id).includes('effort high -> gemini-4-neon-high'), 'mapping note');
    await until(() => settled(started.id), 'run to settle');
    const step = store.getRun(started.id)?.steps.find((candidate) => candidate.id === 'work');
    expect(step?.modelIdentity).toContain('gemini-4-neon-high');
    expect(step?.reasoningEffort).toBeUndefined();
  }, 40_000);

  it('a step effort with no variant is refused, listing the valid ones', async () => {
    setAntigravityEffortCatalog({ get: async () => ({ runner: 'antigravity', source: 'live', stale: false, models: ['gemini-4-neon-low', 'gemini-4-neon-high'].map((id) => ({ id, label: id, description: '' })) }) });
    manager = new RunManager(store, repoRoot);
    const started = manager.startRun(workflow({ model: 'gemini-4-neon', reasoningEffort: 'medium' }), { task: 'do it', worktree: false });
    await until(() => settled(started.id), 'run to settle');
    const record = store.getRun(started.id);
    expect(record?.status).toBe('failed');
    expect(`${record?.error ?? ''}\n${record?.steps.map((step) => step.error ?? '').join('\n')}`).toContain("antigravity has no 'medium' variant of gemini-4-neon. Valid for gemini-4-neon: gemini-4-neon-low, gemini-4-neon-high");
  }, 40_000);
});
