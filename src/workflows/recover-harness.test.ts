import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harnessWorkflowDefs, HARNESS_FIX_ISSUE } from '../harness/workflows.js';
import { RunStore } from '../runs/store.js';
import { WorkspaceSemaphore } from '../workspace/semaphore.js';
import { RunManager } from './run.js';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery for harness runs (spec 2026-07-23-harness-orchestration,
 * Edge Cases): a harness run interrupted mid-phase is RE-QUEUED — the driver
 * re-enters its ledger and skips completed phases — never resumed through the
 * dead session transcript (`continueRun`), whose context is worthless by
 * design. A frozen workspace semaphore keeps the queue from dispatching so
 * nothing actually spawns.
 */
describe('recover() and harness runs', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-harness-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('re-queues an interrupted running harness run instead of resuming its session', async () => {
    const def = harnessWorkflowDefs().find((w) => w.name === HARNESS_FIX_ISSUE)!;
    const { id } = store.createRun({
      title: 't',
      workflow: HARNESS_FIX_ISSUE,
      task: 'Fix issue #642',
      steps: def.steps.map((s) => ({ id: s.id, name: s.name ?? s.id, kind: s.command ? 'check' as const : 'agent' as const })),
    });
    store.updateRun(id, {
      status: 'running',
      workflowDef: def as unknown as Record<string, unknown>,
      harness: { profile: 'standard', workflow: HARNESS_FIX_ISSUE, issueId: '642' },
    });
    store.updateStep(id, 'implement', { status: 'running' });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    const recovered = store.getRun(id);
    expect(recovered?.status).toBe('queued');
    expect(recovered?.harness?.profile).toBe('standard');
    // The interrupted phase's step resets to pending — the driver restarts it
    // fresh from the ledger; nothing is marked failed.
    expect(recovered?.steps.find((s) => s.id === 'implement')?.status).toBe('pending');
    const events = store.readEvents(id);
    expect(events.some((e) => typeof e.message === 'string' && /ledger/.test(e.message as string))).toBe(true);
  });
});
