import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager, type ProviderGate } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const SIGNED_OUT = 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.';

/**
 * Engine-started launches ask the provider gate the HTTP routes ask (spec
 * 2026-10-24-agent-cli-error-cooperation item 3, telemetry bca23063): the queue, `recover()` and
 * the auto-resume timer used to spawn a signed-out CLI. A refusal fails the run with the gate's
 * message before anything spawns — the 409 a route answers — and books no automatic resume, so a
 * run refused for auth cannot loop. Exits from that `failed`: Continue / Retry (gated again).
 */
describe('the engine asks the provider gate before it spawns', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
  const settled = (runId: string) =>
    expect.poll(() => terminal.has(store.getRun(runId)?.status ?? ''), { timeout: 20_000 }).toBe(true);
  const spawned = (runId: string) => store.readEvents(runId).some((event) => event.type === 'step-start');
  const stepStatus = (runId: string, stepId: string) =>
    store.getRun(runId)?.steps.find((step) => step.id === stepId)?.status;

  /** A run the previous process left mid-turn, with a session to resume. */
  function interruptedRun(): string {
    const record = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'mock:done ship it',
      runner: 'claude',
      agentProfile: 'work',
      worktree: false,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' as const }],
    });
    store.updateRun(record.id, { status: 'running', startedAt: new Date().toISOString() });
    store.updateStep(record.id, 'work', { status: 'running', sessionId: 'sess-1', backend: 'claude', profileId: 'work' });
    return record.id;
  }

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_ERROR_RESULT = process.env.CEZ_MOCK_ERROR_RESULT;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_MOCK_ERROR_RESULT;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-provider-gate-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await exec('git', ['add', '-A'], { cwd: repoRoot });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
  });

  afterEach(async () => {
    if (manager) {
      for (const { id } of store.listRuns()) manager.cancel(id);
      const deadline = Date.now() + 10_000;
      while (store.listRuns().some(({ id }) => manager?.isActive(id)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      manager.dispose();
      manager = undefined;
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('a queued run against a signed-out provider fails with the gate message and spawns nothing', async () => {
    const gate = vi.fn<ProviderGate>(async () => SIGNED_OUT);
    manager = new RunManager(store, repoRoot, { providerGate: gate });
    const record = manager.startRun(workflow, { task: 'mock:done ship it', worktree: false, agentProfile: 'work' });
    await settled(record.id);

    const failed = store.getRun(record.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe(SIGNED_OUT);
    expect(failed?.autoResumeAt).toBeUndefined();
    expect(spawned(record.id)).toBe(false);
    expect(gate).toHaveBeenCalledTimes(1);
    const [required, scope] = gate.mock.calls[0]!;
    expect(required).toEqual(['claude']);
    expect(scope.repoRoot).toBe(repoRoot);
    // The account the run will use is the one judged (ac53a6ef).
    expect(scope.profileFor?.('claude')).toBe('work');
    expect(manager.isActive(record.id)).toBe(false);
  }, 30_000);

  it('an allowing gate changes nothing — the run starts as before', async () => {
    const gate = vi.fn<ProviderGate>(async () => null);
    manager = new RunManager(store, repoRoot, { providerGate: gate });
    const record = manager.startRun(workflow, { task: 'mock:done ship it', worktree: false });
    await settled(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
    expect(gate).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('no gate (headless `cezar run`, tests) = unchanged: a run starts without asking anyone', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { task: 'mock:done ship it', worktree: false });
    await settled(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
    expect(spawned(record.id)).toBe(true);
  }, 30_000);

  it('a gate that throws lets the launch through rather than wedging the queue', async () => {
    manager = new RunManager(store, repoRoot, { providerGate: async () => { throw new Error('probe broke'); } });
    const record = manager.startRun(workflow, { task: 'mock:done ship it', worktree: false });
    await settled(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  }, 30_000);

  it('recover() does not resume an interrupted run into a signed-out provider, and does not retry it', async () => {
    const runId = interruptedRun();
    const gate = vi.fn<ProviderGate>(async () => SIGNED_OUT);
    manager = new RunManager(store, repoRoot, { providerGate: gate });
    await manager.recover();

    await expect.poll(() => stepStatus(runId, 'continue-1'), { timeout: 20_000 }).toBe('failed');
    await settled(runId);
    const after = store.getRun(runId);
    expect(after?.status).toBe('failed');
    expect(after?.error).toBe(SIGNED_OUT);
    expect(after?.autoResumeAt).toBeUndefined();
    expect(spawned(runId)).toBe(false);
    expect(gate.mock.calls[0]?.[0]).toEqual(['claude']);
    expect(gate.mock.calls[0]?.[1].profileFor?.('claude')).toBe('work');
    // Held for auth = settled, not spinning: no further launch attempt follows.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(gate).toHaveBeenCalledTimes(1);
    expect(store.getRun(runId)?.steps.some((step) => step.id === 'continue-2')).toBe(false);
  }, 30_000);

  it('a transient retry the timer fires is refused too, and books no further retry', async () => {
    // The retry is booked by a manager without a gate…
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { task: 'mock:overloaded ship it', worktree: false });
    await settled(record.id);
    expect(store.getRun(record.id)?.autoResumeReason).toBe('transient');
    manager.dispose();

    // …and fires (deadline passed, the `fireAutoResume` the timer calls) after the user signed out.
    store.updateRun(record.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    const gate = vi.fn<ProviderGate>(async () => SIGNED_OUT);
    manager = new RunManager(store, repoRoot, { providerGate: gate });
    await manager.recover();

    await expect.poll(() => stepStatus(record.id, 'continue-1'), { timeout: 20_000 }).toBe('failed');
    await settled(record.id);
    const after = store.getRun(record.id);
    expect(after?.error).toBe(SIGNED_OUT);
    expect(after?.autoResumeAt).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(gate).toHaveBeenCalledTimes(1);
  }, 40_000);

  it('Continue after the user signs back in starts the run (the exit from the refusal)', async () => {
    let signedIn = false;
    const gate = vi.fn<ProviderGate>(async () => (signedIn ? null : SIGNED_OUT));
    const runId = interruptedRun();
    manager = new RunManager(store, repoRoot, { providerGate: gate });
    await manager.recover();
    await expect.poll(() => stepStatus(runId, 'continue-1'), { timeout: 20_000 }).toBe('failed');
    await settled(runId);

    signedIn = true;
    expect(manager.continueRun(runId, { text: 'go on' })).toEqual({ ok: true });
    // The reopened session ran its turn (an interactive Continue then parks at `waiting`).
    await expect.poll(() => ['waiting', 'done'].includes(stepStatus(runId, 'continue-2') ?? ''), { timeout: 20_000 }).toBe(true);
    expect(spawned(runId)).toBe(true);
  }, 40_000);
});
