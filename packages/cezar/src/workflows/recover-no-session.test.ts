import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery of a `running` run that never reached an agent session — it was still queued
 * behind the working-tree lease, or spawning, when the process died. `continueRun` has nothing
 * to resume there, and until now the run was failed with "no agent session to resume" and no way
 * forward (the first live dispatch tree lost a task exactly so). It goes back to the queue whole.
 */
describe('recover() and a running run with no agent session', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-nosession-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const WORKFLOW_DEF = {
    name: 'quick-task',
    description: 'x',
    source: 'built-in' as const,
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  const lifecycle = (id: string): string[] =>
    readFileSync(join(repoRoot, '.ai/cezar/runs', `${id}.ndjson`), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((e) => e.type === 'lifecycle')
      .map((e) => String(e.message));

  it('re-queues it instead of failing it on "no agent session to resume"', async () => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF, status: 'running', startedAt: new Date().toISOString(), currentStepId: 'work' });
    store.updateStep(id, 'work', { status: 'running' });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    const record = store.getRun(id);
    expect(record?.status).toBe('queued');
    expect(record?.error).toBeUndefined();
    expect(record?.steps.find((s) => s.id === 'work')?.status).toBe('pending');
    expect(lifecycle(id)).toContain('cezar restarted — the task had not reached its agent session — task re-queued');
  });

  it('still resumes a running run that HAS a session, the way it always did', async () => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF, status: 'running', startedAt: new Date().toISOString(), currentStepId: 'work' });
    store.updateStep(id, 'work', { status: 'running', sessionId: 'sess-1', backend: 'claude' });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    // The continuation path: interrupted, then resumed from the recorded session (queued here
    // only because the semaphore is frozen).
    expect(lifecycle(id)).toContain('cezar restarted — resuming the interrupted task from its last session');
    expect(lifecycle(id)).not.toContain('cezar restarted — the task had not reached its agent session — task re-queued');
  });
});
