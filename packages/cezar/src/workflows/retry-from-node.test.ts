import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { graphToSteps, type WorkflowGraph } from './graph.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const sh = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** #1733: "Retry from…" re-enters a failed workflow's graph at a node, without a restart. */
describe('RunManager.retryRun', () => {
  let repoRoot: string;
  let flagDir: string;
  let store: RunStore;
  let manager: RunManager;
  let savedDryRun: string | undefined;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retry-node-'));
    flagDir = mkdtempSync(join(tmpdir(), 'cez-retry-flag-'));
    savedDryRun = process.env.CEZ_DRY_RUN;
    process.env.CEZ_DRY_RUN = '1';
    await sh('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await sh('git', ['add', '-A'], { cwd: repoRoot });
    await sh('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(flagDir, { recursive: true, force: true });
  });

  async function settle(id: string) {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(id)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((r) => setTimeout(r, 100));
    }
    return store.getRun(id)!;
  }

  // `pushed` fails until the flag exists (fixed "outside cezar"); its fail port is unwired.
  const flow = (): WorkflowDef => {
    const flag = join(flagDir, 'fixed.flag');
    const ran = join(flagDir, 'review.ran');
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'implement', type: 'agent', prompt: '{{task}}' },
        { id: 'pushed', type: 'check', command: `test -f '${flag}'` },
        { id: 'review', type: 'check', command: `touch '${ran}'` },
        { id: 'ok', type: 'end', status: 'success' },
      ],
      edges: [
        { from: 'start', to: 'implement' },
        { from: 'implement', to: 'pushed' },
        { from: 'pushed.pass', to: 'review' },
        { from: 'review.pass', to: 'ok' },
      ],
    };
    return { name: 'graph', source: 'file', steps: graphToSteps(graph), graph };
  };

  it('walks the rest of the graph from the failed check, without re-running the agent', async () => {
    const failed = await settle(manager.startRun(flow(), { task: 'ship it', worktree: false }).id);
    expect(failed.status).toBe('failed');
    expect(failed.graphState?.taken.at(-1)).toMatch(/^pushed\.fail->/);
    writeFileSync(join(flagDir, 'fixed.flag'), '');

    expect(await manager.retryRun(failed.id, 'pushed')).toEqual({ ok: true });
    const final = await settle(failed.id);

    expect(final.status).not.toBe('failed');
    expect(existsSync(join(flagDir, 'review.ran'))).toBe(true);
    expect(final.steps.map((s) => [s.id, s.status, s.iterations])).toEqual([
      ['implement', 'done', 1],
      ['pushed', 'done', 2],
      ['review', 'done', 1],
    ]);
    expect(final.graphState?.taken).toEqual([
      'start.next->implement',
      'implement.done->pushed',
      'pushed.pass->review',
      'review.pass->ok',
    ]);
  }, 30_000);

  it('settles a leftover continuation first, so it cannot take the run over', async () => {
    const failed = await settle(manager.startRun(flow(), { task: 'ship it', worktree: false }).id);
    store.addStep(failed.id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    writeFileSync(join(flagDir, 'fixed.flag'), '');

    expect(await manager.retryRun(failed.id, 'pushed')).toEqual({ ok: true });
    const final = await settle(failed.id);

    expect(existsSync(join(flagDir, 'review.ran'))).toBe(true);
    expect(final.steps.find((s) => s.id === 'continue-1')?.status).toBe('skipped');
  }, 30_000);

  it('adopts the clean branch an agent switched the worktree to', async () => {
    const failed = await settle(manager.startRun(flow(), { task: 'ship it' }).id);
    expect(failed.status).toBe('failed');
    expect(failed.worktreePath).toBeDefined();
    await sh('git', ['checkout', '-q', '-b', 'feat/own-branch'], { cwd: failed.worktreePath! });
    writeFileSync(join(flagDir, 'fixed.flag'), '');

    // A double click: the branch checks await git, and still exactly one retry lands.
    const answers = await Promise.all([manager.retryRun(failed.id, 'pushed'), manager.retryRun(failed.id, 'pushed')]);
    expect(answers.filter((a) => a.ok)).toHaveLength(1);
    const final = await settle(failed.id);

    expect(final.status).not.toBe('failed');
    expect(final.branch).toBe('feat/own-branch');
    expect(existsSync(join(flagDir, 'review.ran'))).toBe(true);
  }, 30_000);

  it('refuses a dirty worktree on another branch, an agent node, and a run that did not fail', async () => {
    const failed = await settle(manager.startRun(flow(), { task: 'ship it' }).id);
    await sh('git', ['checkout', '-q', '-b', 'feat/dirty'], { cwd: failed.worktreePath! });
    writeFileSync(join(failed.worktreePath!, 'wip.txt'), 'wip\n');
    expect(await manager.retryRun(failed.id, 'pushed')).toMatchObject({ ok: false, error: expect.stringContaining('uncommitted') });
    expect(store.getRun(failed.id)?.status).toBe('failed');
    expect(store.getRun(failed.id)?.branch).not.toBe('feat/dirty');

    expect(await manager.retryRun(failed.id, 'implement')).toMatchObject({ ok: false });

    writeFileSync(join(flagDir, 'fixed.flag'), '');
    const passed = await settle(manager.startRun(flow(), { task: 'fine', worktree: false }).id);
    expect(passed.status).not.toBe('failed');
    expect(await manager.retryRun(passed.id, 'pushed')).toMatchObject({ ok: false, error: expect.stringContaining('did not fail') });
  }, 30_000);
});
