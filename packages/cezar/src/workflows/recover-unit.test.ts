import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunUnit } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager, type StartRunInput } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Restart recovery vs the unit hierarchy (spec 2026-09-08-units-hierarchy), the sibling of
 * `recover-autonomous.test.ts` and for the identical reason: `recover()` re-queues a `queued` run
 * by rebuilding its `StartRunInput` from the persisted record, and it is the ONE engine path that
 * does not go through `startRun`. A field it forgets to re-thread is simply gone from the
 * rebuilt input, silently, with the record still carrying it.
 *
 * That silence is why the second assertion here reaches for the rebuilt input rather than
 * settling for the record. `recover()` never *writes* `unit`, so a record-only check is green
 * with or without the fix — the exact shape of green-either-way test AGENTS.md warns about. The
 * hydration spy is what actually fails when the re-thread is removed.
 *
 * A workspace semaphore capped at 0 freezes the queue, so nothing is ever dispatched and no
 * agent process is spawned.
 */
describe('recover() and the unit field', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-unit-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  const WORKFLOW_DEF = {
    name: 'quick-task',
    description: 'x',
    source: 'built-in' as const,
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** A queued run mid-mission: a legate spawned by a caesar, with a carved-out budget. */
  const queuedUnitRun = (): { id: string; unit: RunUnit } => {
    const { id } = store.createRun({
      title: 'flank left',
      workflow: 'quick-task',
      task: 'take the left flank',
      autonomous: true,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    const unit: RunUnit = {
      role: 'legate',
      missionId: 'mission-1',
      parentRunId: 'caesar-1',
      budgetUsd: 4,
      ladder: { legate: { runner: 'claude', model: 'sonnet' } },
    };
    store.updateRun(id, { workflowDef: WORKFLOW_DEF, unit });
    return { id, unit };
  };

  /** Capture what `reviveQueuedRun` hands `hydrateQueuedInput` — the rebuilt input itself,
   *  which is the thing `execute()` will later run from. Private by design, so the spy reaches
   *  through the prototype; that is the only seam between recovery and dispatch. */
  const captureRebuiltInput = (): StartRunInput[] => {
    const seen: StartRunInput[] = [];
    vi.spyOn(
      RunManager.prototype as unknown as { hydrateQueuedInput: (id: string, input: StartRunInput) => StartRunInput },
      'hydrateQueuedInput',
    ).mockImplementation((_id, input) => {
      seen.push(input);
      return input;
    });
    return seen;
  };

  it('keeps the unit on the record across a restart', async () => {
    const { id, unit } = queuedUnitRun();
    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();
    expect(store.getRun(id)?.status).toBe('queued');
    expect(store.getRun(id)?.unit).toEqual(unit);
  });

  it('re-threads the unit into the rebuilt input, so the run resumes IN its mission', async () => {
    const rebuilt = captureRebuiltInput();
    const { unit } = queuedUnitRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]?.unit).toEqual(unit);
    // The neighbouring re-thread this one was modeled on, pinned so the two cannot diverge.
    expect(rebuilt[0]?.autonomous).toBe(true);
  });

  it('leaves an ordinary flat run without a unit — the field stays absent, not empty', async () => {
    const rebuilt = captureRebuiltInput();
    const { id } = store.createRun({
      title: 'plain',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, { workflowDef: WORKFLOW_DEF });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    expect(store.getRun(id)?.unit).toBeUndefined();
    expect(rebuilt[0]?.unit).toBeUndefined();
  });

  it('survives the record being written and read back off disk', () => {
    const { id, unit } = queuedUnitRun();
    store.flush();
    // A second store over the same dataDir parses `runs.json` from scratch, which is what a
    // restart really does — the persistence twin of `unitSchema` has to accept its own output.
    expect(RunStore.open(join(repoRoot, '.ai/cezar')).getRun(id)?.unit).toEqual(unit);
  });
});
