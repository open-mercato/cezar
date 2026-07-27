import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.js';
import { WorkspaceSemaphore } from '../workspace/semaphore.js';
import { RunManager } from './run.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery vs the inbox ceiling (#471).
 *
 * `recover()` re-queues runs that were `queued` when the process died, rebuilding their
 * StartRunInput straight from the persisted record — the one path into the engine that does NOT
 * go through `startRun`. A run queued while `CEZ_FOLLOWUPS=1` and recovered after the flag was
 * dropped must not come back claiming it generates follow-ups: `execute()` gates the agent at
 * spawn time regardless, so the behavior was always safe, but the record would have kept
 * echoing `generateFollowups: true` for a run that produces none.
 *
 * These tests only exercise `recover()`'s bookkeeping — a workspace semaphore capped at 0
 * (the cap is workspace-level since spec 2026-07-20, step 2.5) keeps the queue from actually
 * dispatching, so nothing spawns.
 */
describe('recover() and the follow-up ceiling (#471)', () => {
  let repoRoot: string;
  let store: RunStore;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  // Capped at 0 — recover() re-queues, the queue never drains, no agent is spawned.
  const frozen = () =>
    new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
  });

  const WORKFLOW_DEF = {
    name: 'quick-task',
    description: 'x',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** A run left `queued` by a crash. `workflowDef` is persisted by a follow-up updateRun, the
   *  way startRun does it (run.ts:254) — recover() revives the workflow from it. */
  const queuedRun = (generateFollowups: boolean): string => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      generateFollowups,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF as unknown as Record<string, unknown> });
    return id;
  };

  it('normalizes a recovered record to false when the inbox is off', async () => {
    delete process.env.CEZ_FOLLOWUPS;
    const id = queuedRun(true);
    expect(store.getRun(id)?.generateFollowups).toBe(true); // the pre-restart truth

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    // The record must not keep claiming follow-ups it will never produce.
    expect(store.getRun(id)?.generateFollowups).toBe(false);
    expect(store.getRun(id)?.status).toBe('queued'); // still recovered, just honest
  });

  it('leaves the record alone when the inbox is on', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    const id = queuedRun(true);

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.generateFollowups).toBe(true);
  });

  it('does not resurrect an explicit per-run opt-out', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    const id = queuedRun(false);

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.generateFollowups).toBe(false);
  });
});
